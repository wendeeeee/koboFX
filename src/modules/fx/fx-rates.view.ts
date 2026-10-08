import { CurrencyPair } from './currency-pair.repository';
import { RateTier, ageSeconds } from './freshness';
import { ServedSnapshot } from './fx-rate.service';
import { clientRateOf, displayRate, triangulatedMid } from './pricing';

export const RATE_ATTRIBUTION = { text: 'Rates By Exchange Rate API', url: 'https://www.exchangerate-api.com' } as const;

export interface PairRateView {
  readonly from: string;
  readonly to: string;
  readonly midRate: string;
  readonly clientRate: string;
  readonly spreadBasisPoints: number;
  readonly minimumSourceAmount: string;
}

export interface RatesView {
  readonly provider: string;
  readonly snapshotId: string;
  readonly asOf: string;
  readonly fetchedAt: string;
  readonly rateAgeSeconds: number;
  readonly stale: boolean;
  readonly attribution: typeof RATE_ATTRIBUTION;
  readonly pairs: PairRateView[];
}

export function ratesView(served: ServedSnapshot, pairs: readonly CurrencyPair[]): RatesView {
  const { snapshot, freshness } = served;
  const views: PairRateView[] = [];
  for (const pair of pairs) {
    const sourceUsd = snapshot.rates.get(pair.sourceCurrency);
    const targetUsd = snapshot.rates.get(pair.targetCurrency);
    if (!sourceUsd || !targetUsd) continue;
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
