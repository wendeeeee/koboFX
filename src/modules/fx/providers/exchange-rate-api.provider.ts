import { Logger } from '@nestjs/common';
import { ProviderHttpClient, ResponseClassification } from '../../../common/http/provider-http-client';
import { ProviderRequestRejectedError, ProviderResponseInvalidError, ProviderUnavailableError } from '../../../common/http/provider.errors';
import { ProviderRequestBudgetSpentError } from '../fx.errors';
import { FetchFailureKind } from '../poll-schedule';
import { ExchangeRateApiErrorType, ParsedRates, parseLatestResponse } from './exchange-rate-api.responses';
import { FetchLatestOptions, RateProvider, RateProviderResult } from './rate-provider.port';

export const API_KEY_PLACEHOLDER = '{apiKey}';
const BASE_CURRENCY = 'USD';
/** Our own code for the open endpoint's HTTP 429 (it sends no error body we can rely on). */
export const RATE_LIMITED_CODE = 'rate-limited';

/** What each `error-type` means for pacing (checked against the docs 2026-09-29). */
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
      // unsupported-code, malformed-request, an undocumented error-type, another 4xx: our bug
      // or a contract change. Never retried in a loop.
      return FetchFailureKind.REQUEST_REJECTED;
  }
}

/**
 * How an ExchangeRate-API answer is read (handbook: "a 200 carrying an error body"; the
 * status code alone never decides):
 * - an error body (`result: "error"`), whatever the HTTP status → definitive, never
 *   retried in a loop (`quota-reached`, `invalid-key`, `inactive-account` included; the
 *   recorded `invalid-key` came with a 403);
 * - HTTP 429 → definitive (`rate-limited`): the open endpoint locks the IP out for 20
 *   minutes, and retrying inside that window only extends the outage;
 * - 5xx → transient; an unreadable body → invalid (both retried);
 * - a readable success on another status → definitive.
 */
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
  /** Up to and including `/latest`; may hold `{apiKey}` (the keyed v6 endpoint). */
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
}

/**
 * ExchangeRate-API v6 (`/latest/USD`), keyed or open access. The key, when there is one,
 * travels in the URL PATH (the standard endpoint has no header option — handbook:
 * "tokens passed in URLs"): only a path with `[REDACTED]` in its place reaches
 * `provider_calls` and logs, and the shared client scrubs the key from every error text
 * and body as a second line of defence. Rotation is configuration + restart.
 */
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
