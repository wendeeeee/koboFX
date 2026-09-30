/**
 * Freshness tiers (design §7.4, redefined by Phase 6 decision §5.2 — "a stale rate may
 * be displayed; it may never be executed against").
 *
 * §7.4's "≤ 120s from our fetch" cannot be met on the provider's own time by any plan
 * (it publishes every 5 minutes at best, daily on Free/open access), and our fetch time
 * alone proves nothing between publications (re-fetching an unchanged rate is not newer
 * information). So the rate's age is measured from the PROVIDER's publication time
 * (`time_last_update_unix`), and a snapshot is:
 *
 * - **EXECUTABLE** iff it is the provider's current publication — `now <
 *   providerNextUpdateAt + publicationGrace` (we have checked since the last scheduled
 *   publication) — AND `age ≤ executableMaximumAge`;
 * - **DISPLAY_ONLY** iff `age ≤ displayMaximumAge` (shown with `stale: true`; execution
 *   gets `503 FX_RATE_STALE`);
 * - **UNSERVABLE** beyond that: not shown at all.
 *
 * Both limits are inclusive. The decision is read from the snapshot's own fields and the
 * injectable clock — never inferred from a cache TTL.
 */
export enum RateTier {
  EXECUTABLE = 'EXECUTABLE',
  DISPLAY_ONLY = 'DISPLAY_ONLY',
  UNSERVABLE = 'UNSERVABLE',
}

export interface FreshnessPolicy {
  readonly executableMaximumAgeSeconds: number;
  readonly displayMaximumAgeSeconds: number;
  readonly publicationGraceSeconds: number;
}

export interface SnapshotTimes {
  readonly providerUpdatedAt: Date;
  readonly providerNextUpdateAt: Date;
  /** `manual` (Phase 10): valid until its next-update time exactly — an approved validity gets no grace. */
  readonly provider?: string;
}

export interface Freshness {
  readonly tier: RateTier;
  /** Age of the rate itself, from the provider's publication time, in milliseconds (never negative). */
  readonly ageMilliseconds: number;
  /** True while no newer publication can exist that we have not fetched. */
  readonly isCurrentPublication: boolean;
}

export function freshnessOf(snapshot: SnapshotTimes, now: Date, policy: FreshnessPolicy): Freshness {
  const ageMilliseconds = Math.max(0, now.getTime() - snapshot.providerUpdatedAt.getTime());
  const graceSeconds = snapshot.provider === 'manual' ? 0 : policy.publicationGraceSeconds;
  const isCurrentPublication = now.getTime() < snapshot.providerNextUpdateAt.getTime() + graceSeconds * 1000;
  let tier: RateTier;
  if (isCurrentPublication && ageMilliseconds <= policy.executableMaximumAgeSeconds * 1000) tier = RateTier.EXECUTABLE;
  else if (ageMilliseconds <= policy.displayMaximumAgeSeconds * 1000) tier = RateTier.DISPLAY_ONLY;
  else tier = RateTier.UNSERVABLE;
  return { tier, ageMilliseconds, isCurrentPublication };
}

/** Whole seconds, rounded up: an age of 0.2s is reported as 1s, never as fresher than it is. */
export function ageSeconds(freshness: Freshness): number {
  return Math.ceil(freshness.ageMilliseconds / 1000);
}
