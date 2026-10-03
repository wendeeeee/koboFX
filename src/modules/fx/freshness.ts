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
  readonly provider?: string;
}

export interface Freshness {
  readonly tier: RateTier;
  readonly ageMilliseconds: number;
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

export function ageSeconds(freshness: Freshness): number {
  return Math.ceil(freshness.ageMilliseconds / 1000);
}
