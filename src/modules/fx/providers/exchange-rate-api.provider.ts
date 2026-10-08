import { Logger } from '@nestjs/common';
import { ProviderHttpClient, ResponseClassification } from '../../../common/http/provider-http-client';
import { ProviderRequestRejectedError, ProviderResponseInvalidError, ProviderUnavailableError } from '../../../common/http/provider.errors';
import { ProviderRequestBudgetSpentError } from '../fx.errors';
import { FetchFailureKind } from '../poll-schedule';
import { ExchangeRateApiErrorType, ParsedRates, parseLatestResponse } from './exchange-rate-api.responses';
import { FetchLatestOptions, RateProvider, RateProviderResult } from './rate-provider.port';

export const API_KEY_PLACEHOLDER = '{apiKey}';
const BASE_CURRENCY = 'USD';
export const RATE_LIMITED_CODE = 'rate-limited';

export function failureKindOf(providerErrorCode: string | null): FetchFailureKind {
  switch (providerErrorCode) {
    case ExchangeRateApiErrorType.QUOTA_REACHED:
      return FetchFailureKind.QUOTA_REACHED;
    case ExchangeRateApiErrorType.INVALID_KEY:
    case ExchangeRateApiErrorType.INACTIVE_ACCOUNT:
      return FetchFailureKind.CREDENTIALS_REJECTED;
    case RATE_LIMITED_CODE:
      return FetchFailureKind.RATE_LIMITED;
    default:
      return FetchFailureKind.REQUEST_REJECTED;
  }
}

export function classifyExchangeRateApiResponse(status: number, text: string, knownCurrencies: readonly string[]): ResponseClassification<ParsedRates> {
  const parsed = parseLatestResponse(text, knownCurrencies);
  if (parsed.kind === 'ERROR') {
    return { outcome: 'DEFINITIVE', error: `provider error ${parsed.errorType} (HTTP ${status})`, providerErrorCode: parsed.errorType };
  }
  if (status === 429) return { outcome: 'DEFINITIVE', error: 'rate limited (HTTP 429)', providerErrorCode: RATE_LIMITED_CODE };
  if (status >= 500) return { outcome: 'TRANSIENT', error: `provider error ${status}` };
  if (parsed.kind === 'INVALID') return { outcome: 'INVALID', error: parsed.reason };
  if (status < 200 || status >= 300) return { outcome: 'DEFINITIVE', error: `unexpected HTTP ${status}`, providerErrorCode: `http-${status}` };
  return { outcome: 'OK', value: parsed };
}

export interface ExchangeRateApiProviderOptions {
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
}

export class ExchangeRateApiProvider extends RateProvider {
  private readonly logger = new Logger(ExchangeRateApiProvider.name);
  readonly name: string;
  private readonly realUrl: string;
  private readonly recordedUrl: string;

  constructor(
    options: ExchangeRateApiProviderOptions,
    private readonly client: ProviderHttpClient,
  ) {
    super();
    this.name = options.name;
    const base = options.baseUrl.replace(/\/+$/, '');
    this.realUrl = `${base.split(API_KEY_PLACEHOLDER).join(encodeURIComponent(options.apiKey ?? ''))}/${BASE_CURRENCY}`;
    this.recordedUrl = `${base.split(API_KEY_PLACEHOLDER).join('[REDACTED]')}/${BASE_CURRENCY}`;
  }

  async fetchLatest(options: FetchLatestOptions): Promise<RateProviderResult> {
    try {
      const response = await this.client.send({
        operation: 'latest-rates',
        method: 'GET',
        path: this.realUrl,
        recordedPath: this.recordedUrl,
        retryable: true,
        maximumAttempts: options.maximumAttempts,
        beforeAttempt: options.beforeAttempt,
        classify: (status, text) => classifyExchangeRateApiResponse(status, text, options.knownCurrencies),
      });
      return { kind: 'RATES', rates: response.value, providerCallId: response.providerCallId };
    } catch (error) {
      if (error instanceof ProviderRequestBudgetSpentError) {
        return { kind: 'FAILURE', failure: FetchFailureKind.BUDGET_SPENT, detail: error.message, providerErrorCode: null };
      }
      if (error instanceof ProviderRequestRejectedError) {
        return { kind: 'FAILURE', failure: failureKindOf(error.providerErrorCode), detail: error.message, providerErrorCode: error.providerErrorCode };
      }
      if (error instanceof ProviderResponseInvalidError) {
        return { kind: 'FAILURE', failure: FetchFailureKind.INVALID_RESPONSE, detail: error.message, providerErrorCode: null };
      }
      if (error instanceof ProviderUnavailableError) {
        return { kind: 'FAILURE', failure: FetchFailureKind.TRANSIENT, detail: error.message, providerErrorCode: null };
      }
      this.logger.error({ err: error }, 'Unexpected error calling the FX provider');
      return { kind: 'FAILURE', failure: FetchFailureKind.TRANSIENT, detail: 'unexpected error', providerErrorCode: null };
    }
  }
}
