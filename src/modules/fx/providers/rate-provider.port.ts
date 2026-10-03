import { FetchFailureKind } from '../poll-schedule';
import { ParsedRates } from './exchange-rate-api.responses';

export interface FetchLatestOptions {
  readonly knownCurrencies: readonly string[];
  readonly beforeAttempt?: (attempt: number) => Promise<void>;
  readonly maximumAttempts?: number;
}

export type RateProviderResult =
  | { readonly kind: 'RATES'; readonly rates: ParsedRates; readonly providerCallId: string | undefined }
  | { readonly kind: 'FAILURE'; readonly failure: FetchFailureKind; readonly detail: string; readonly providerErrorCode: string | null };

export abstract class RateProvider {
  abstract readonly name: string;
  abstract fetchLatest(options: FetchLatestOptions): Promise<RateProviderResult>;
}
