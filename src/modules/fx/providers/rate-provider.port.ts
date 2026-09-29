import { FetchFailureKind } from '../poll-schedule';
import { ParsedRates } from './exchange-rate-api.responses';

export interface FetchLatestOptions {
  /** Currencies whose rates we read; everything else in the response is ignored. */
  readonly knownCurrencies: readonly string[];
  /** Runs before every attempt, retries included (the request budget); throwing sends nothing. */
  readonly beforeAttempt?: (attempt: number) => Promise<void>;
  /** A single attempt when a caller is waiting (the synchronous catch-up's latency budget). */
  readonly maximumAttempts?: number;
}

export type RateProviderResult =
  | { readonly kind: 'RATES'; readonly rates: ParsedRates; readonly providerCallId: string | undefined }
  | { readonly kind: 'FAILURE'; readonly failure: FetchFailureKind; readonly detail: string; readonly providerErrorCode: string | null };

/**
 * The FX rate provider port (user decision 2026-09-29: one provider, ExchangeRate-API,
 * behind a port so a second one can be added without touching callers). Returns
 * USD-based reference mids — one call covers every pair (design §7.4). Never throws for
 * a provider failure: every outcome is a value the fetcher paces and records.
 */
export abstract class RateProvider {
  abstract readonly name: string;
  abstract fetchLatest(options: FetchLatestOptions): Promise<RateProviderResult>;
}
