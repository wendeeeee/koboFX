/**
 * The provider's plans and what they imply (design §7.2 point 5, redone in Phase 6 §5.3;
 * handbook: "mind the quotas" — do the napkin math before launch).
 *
 * | plan     | publishes   | quota/month | scheduled use/month | our budget (month / day) |
 * |----------|-------------|-------------|---------------------|--------------------------|
 * | OPEN     | daily       | none; 429 → 20-min IP lockout | ≈ 31 | 720 / 24 (≤ hourly, the documented safe rate) |
 * | FREE     | daily       | 1,500       | ≈ 31                | 1,200 / 42               |
 * | PRO      | hourly      | 30,000      | ≈ 744               | 24,000 / 857             |
 * | BUSINESS | every 5 min | 125,000     | ≈ 8,928             | 100,000 / 3,571          |
 *
 * Polling faster than the provider publishes buys nothing: each response says when the
 * next publication lands (`time_next_update_unix`), so we poll just after it. The budget
 * (80% of the quota; daily = monthly / 28) is a hard stop against our own bugs, counted per
 * attempt across every instance. Freshness defaults: executable while the rate is at most
 * one cadence + grace old; displayable for twice that (Business keeps §7.4's 15 minutes).
 */
export enum ProviderPlan {
  OPEN = 'OPEN',
  FREE = 'FREE',
  PRO = 'PRO',
  BUSINESS = 'BUSINESS',
}

export interface ProviderPlanProfile {
  readonly plan: ProviderPlan;
  /** How often the provider publishes new rates. */
  readonly cadenceSeconds: number;
  readonly monthlyQuota: number | null;
  readonly monthlyBudget: number;
  readonly dailyBudget: number;
  readonly executableMaximumAgeSeconds: number;
  readonly displayMaximumAgeSeconds: number;
  /** How long after the announced next publication we still treat our snapshot as current. */
  readonly publicationGraceSeconds: number;
  /** Retry interval when the provider is late (its "next update" time has passed). */
  readonly latePublicationRetrySeconds: number;
  /** Plans whose rates are too old to trade on are refused at boot in production (§5.2). */
  readonly allowedInProduction: boolean;
}

export const PROVIDER_PLAN_PROFILES: Readonly<Record<ProviderPlan, ProviderPlanProfile>> = {
  [ProviderPlan.OPEN]: {
    plan: ProviderPlan.OPEN,
    cadenceSeconds: 86_400,
    monthlyQuota: null,
    monthlyBudget: 720,
    dailyBudget: 24,
    executableMaximumAgeSeconds: 90_000,
    displayMaximumAgeSeconds: 172_800,
    publicationGraceSeconds: 3_600,
    latePublicationRetrySeconds: 3_600,
    allowedInProduction: false,
  },
  [ProviderPlan.FREE]: {
    plan: ProviderPlan.FREE,
    cadenceSeconds: 86_400,
    monthlyQuota: 1_500,
    monthlyBudget: 1_200,
    dailyBudget: 42,
    executableMaximumAgeSeconds: 90_000,
    displayMaximumAgeSeconds: 172_800,
    publicationGraceSeconds: 3_600,
    latePublicationRetrySeconds: 7_200,
    allowedInProduction: false,
  },
  [ProviderPlan.PRO]: {
    plan: ProviderPlan.PRO,
    cadenceSeconds: 3_600,
    monthlyQuota: 30_000,
    monthlyBudget: 24_000,
    dailyBudget: 857,
    executableMaximumAgeSeconds: 3_900,
    displayMaximumAgeSeconds: 7_200,
    publicationGraceSeconds: 300,
    latePublicationRetrySeconds: 300,
    allowedInProduction: true,
  },
  [ProviderPlan.BUSINESS]: {
    plan: ProviderPlan.BUSINESS,
    cadenceSeconds: 300,
    monthlyQuota: 125_000,
    monthlyBudget: 100_000,
    dailyBudget: 3_571,
    executableMaximumAgeSeconds: 420,
    displayMaximumAgeSeconds: 900,
    publicationGraceSeconds: 120,
    latePublicationRetrySeconds: 60,
    allowedInProduction: true,
  },
};
