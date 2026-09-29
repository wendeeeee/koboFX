import { CurrencyPair } from './currency-pair.repository';
import { RateTier, ageSeconds } from './freshness';
import { ServedSnapshot } from './fx-rate.service';
import { clientRateOf, displayRate, triangulatedMid } from './pricing';

/** The open-access terms require it wherever the rates are shown (checked 2026-09-29). */
export const RATE_ATTRIBUTION = { text: 'Rates By Exchange Rate API', url: 'https://www.exchangerate-api.com' } as const;

export interface PairRateView {
  readonly from: string;
  readonly to: string;
  /** Reference mid: `to` per 1 `from` (display only). */
  readonly midRate: string;
  /** What a quote from → to prices at: `mid × (1 − spread)` (display only; quote amounts are authoritative). */
  readonly clientRate: string;
  readonly spreadBasisPoints: number;
  readonly minimumSourceAmount: string;
}

export interface RatesView {
  readonly provider: string;
  /** The snapshot served (provenance: there is no canonical rate). */
  readonly snapshotId: string;
  /** When the provider published these rates — the rate's own time. */
  readonly asOf: string;
  /** When we fetched them. */
  readonly fetchedAt: string;
  /** The rate's true age, from `asOf`, rounded up. */
  readonly rateAgeSeconds: number;
  /** True when the rates may be shown but not executed against (§7.4). */
  readonly stale: boolean;
  readonly attribution: typeof RATE_ATTRIBUTION;
  /** Every active directional pair: both directions are listed, each with its own client rate. */
  readonly pairs: PairRateView[];
}

/**
 * `GET /fx/rates` (design §12): pairs, the mid and each direction's client rate as decimal
 * strings, `asOf`, `stale` and `provider` — and the rate's true age, always.
 */
export function ratesView(served: ServedSnapshot, pairs: readonly CurrencyPair[]): RatesView {
  const { snapshot, freshness } = served;
  const views: PairRateView[] = [];
  for (const pair of pairs) {
    const sourceUsd = snapshot.rates.get(pair.sourceCurrency);
    const targetUsd = snapshot.rates.get(pair.targetCurrency);
    if (!sourceUsd || !targetUsd) continue; // a currency the snapshot does not carry is not priced
    const mid = triangulatedMid(sourceUsd, targetUsd);
    views.push({
      from: pair.sourceCurrency,
      to: pair.targetCurrency,
      midRate: displayRate(mid),
      clientRate: displayRate(clientRateOf(mid, pair.spreadBasisPoints)),
      spreadBasisPoints: pair.spreadBasisPoints,
      minimumSourceAmount: pair.minimumSourceAmountMinor.toString(),
    });
  }
  return {
    provider: snapshot.provider,
    snapshotId: snapshot.id,
    asOf: snapshot.providerUpdatedAt.toISOString(),
    fetchedAt: snapshot.fetchedAt.toISOString(),
    rateAgeSeconds: ageSeconds(freshness),
    stale: freshness.tier !== RateTier.EXECUTABLE,
    attribution: RATE_ATTRIBUTION,
    pairs: views,
  };
}
