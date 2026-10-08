export enum ProviderPlan {
  OPEN = 'OPEN',
  FREE = 'FREE',
  PRO = 'PRO',
  BUSINESS = 'BUSINESS',
}

export interface ProviderPlanProfile {
  readonly plan: ProviderPlan;
  readonly cadenceSeconds: number;
  readonly monthlyQuota: number | null;
  readonly monthlyBudget: number;
  readonly dailyBudget: number;
  readonly executableMaximumAgeSeconds: number;
  readonly displayMaximumAgeSeconds: number;
  readonly publicationGraceSeconds: number;
  readonly latePublicationRetrySeconds: number;
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
