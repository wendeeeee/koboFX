import { FetchFailureKind, LatestFetch, MINIMUM_POLL_GAP_SECONDS, backoffSeconds, budgetPeriods, isPollDue, jitterSeconds, nextPollAt, pages } from './poll-schedule';
import { PROVIDER_PLAN_PROFILES, ProviderPlan, ProviderPlanProfile } from './provider-plan';

const T0 = new Date('2026-09-29T00:02:31.000Z');
const plus = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000);
const BUSINESS = PROVIDER_PLAN_PROFILES[ProviderPlan.BUSINESS];
const OPEN = PROVIDER_PLAN_PROFILES[ProviderPlan.OPEN];

describe('the poll schedule (Phase 6 §5.3)', () => {
  it('never polled → due immediately', () => {
    expect(isPollDue(T0, undefined, OPEN)).toBe(true);
  });

  it('polls just after the announced next publication, with a stable 30–90s jitter', () => {
    const latest: LatestFetch = { snapshotId: 'snapshot-1', fetchedAt: plus(T0, 60), providerUpdatedAt: T0, providerNextUpdateAt: plus(T0, 86_790) };
    const jitter = jitterSeconds('snapshot-1');
    expect(jitter).toBeGreaterThanOrEqual(30);
    expect(jitter).toBeLessThanOrEqual(90);
    expect(jitterSeconds('snapshot-1')).toBe(jitter);
    expect(nextPollAt(latest, OPEN)).toEqual(plus(T0, 86_790 + jitter));
    expect(isPollDue(plus(T0, 86_790 + jitter - 1), latest, OPEN)).toBe(false);
    expect(isPollDue(plus(T0, 86_790 + jitter), latest, OPEN)).toBe(true);
  });

  it('the provider is late (its next-update time had passed when we fetched) → retry after the plan interval', () => {
    const late: LatestFetch = { snapshotId: 's', fetchedAt: plus(T0, 1_000), providerUpdatedAt: T0, providerNextUpdateAt: plus(T0, 900) };
    expect(nextPollAt(late, BUSINESS)).toEqual(plus(T0, 1_000 + BUSINESS.latePublicationRetrySeconds));
    expect(nextPollAt(late, OPEN)).toEqual(plus(T0, 1_000 + OPEN.latePublicationRetrySeconds));
    const unknownTimes: LatestFetch = { snapshotId: 's', fetchedAt: T0, providerUpdatedAt: null, providerNextUpdateAt: null };
    expect(nextPollAt(unknownTimes, BUSINESS)).toEqual(plus(T0, BUSINESS.latePublicationRetrySeconds));
  });

  it('never sooner than the minimum gap, never later than one cadence + grace', () => {
    const imminent: LatestFetch = { snapshotId: 's', fetchedAt: T0, providerUpdatedAt: T0, providerNextUpdateAt: plus(T0, 1) };
    expect(nextPollAt(imminent, BUSINESS).getTime()).toBeGreaterThanOrEqual(plus(T0, MINIMUM_POLL_GAP_SECONDS).getTime());
    const farFuture: LatestFetch = { snapshotId: 's', fetchedAt: T0, providerUpdatedAt: T0, providerNextUpdateAt: plus(T0, 365 * 86_400) };
    expect(nextPollAt(farFuture, BUSINESS)).toEqual(plus(T0, BUSINESS.cadenceSeconds + BUSINESS.publicationGraceSeconds));
  });
});

describe('the schedule keeps a snapshot executable without a gap', () => {
  it.each(Object.values(ProviderPlan))('%s: the jitter is shorter than the grace, so the next poll lands while the snapshot is current', (plan) => {
    const profile = PROVIDER_PLAN_PROFILES[plan];
    expect(90).toBeLessThan(profile.publicationGraceSeconds);
  });
});

describe('failure pacing: the negative cache (Phase 6 §5.10)', () => {
  it('transient failures back off exponentially from 60s to 15 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map((n) => backoffSeconds(FetchFailureKind.TRANSIENT, n, T0))).toEqual([60, 120, 240, 480, 900, 900, 900]);
    expect(backoffSeconds(FetchFailureKind.INVALID_RESPONSE, 1, T0)).toBe(60);
  });

  it('a 429 from the open endpoint waits out its documented 20-minute lockout', () => {
    expect(backoffSeconds(FetchFailureKind.RATE_LIMITED, 1, T0)).toBe(21 * 60);
  });

  it('quota and budget exhaustion wait for the next UTC day; refused credentials and requests wait an hour', () => {
    const lateEvening = new Date('2026-09-29T23:59:00.000Z');
    expect(backoffSeconds(FetchFailureKind.QUOTA_REACHED, 1, T0)).toBe(86_400 - 151);
    expect(backoffSeconds(FetchFailureKind.BUDGET_SPENT, 1, lateEvening)).toBe(60);
    expect(backoffSeconds(FetchFailureKind.CREDENTIALS_REJECTED, 3, T0)).toBe(3_600);
    expect(backoffSeconds(FetchFailureKind.REQUEST_REJECTED, 1, T0)).toBe(3_600);
  });

  it('pages a human only for failures that will not heal on their own', () => {
    expect(Object.values(FetchFailureKind).filter(pages)).toEqual([
      FetchFailureKind.QUOTA_REACHED,
      FetchFailureKind.CREDENTIALS_REJECTED,
      FetchFailureKind.REQUEST_REJECTED,
      FetchFailureKind.BUDGET_SPENT,
    ]);
  });

  it('budget periods are UTC months and days', () => {
    expect(budgetPeriods(new Date('2026-09-30T23:59:59.500Z'))).toEqual({ month: '2026-09', day: '2026-09-30', secondsUntilMonthEnd: 1, secondsUntilDayEnd: 1 });
    expect(budgetPeriods(new Date('2026-12-31T00:00:00.000Z')).secondsUntilMonthEnd).toBe(86_400);
  });
});

/**
 * A simulated month (Phase 6 §5.3: "the poll schedule and request budget, as pure logic
 * over a simulated month"): the provider publishes on its cadence, sometimes late; the
 * poller ticks every 15s and fetches only when the schedule says so; failures back off.
 */
function simulateMonth(profile: ProviderPlanProfile, failureEvery: number) {
  const tickSeconds = 15;
  const start = new Date('2026-09-01T00:00:00.000Z');
  const end = new Date('2026-10-01T00:00:00.000Z');
  let latest: LatestFetch | undefined;
  let backoffUntil = 0;
  let consecutiveFailures = 0;
  let calls = 0;
  const callsPerDay = new Map<string, number>();
  let snapshotNumber = 0;
  for (let now = start.getTime(); now < end.getTime(); now += tickSeconds * 1000) {
    const nowDate = new Date(now);
    if (now < backoffUntil || !isPollDue(nowDate, latest, profile)) continue;
    calls += 1;
    const day = nowDate.toISOString().slice(0, 10);
    callsPerDay.set(day, (callsPerDay.get(day) ?? 0) + 1);
    if (failureEvery > 0 && calls % failureEvery === 0) {
      consecutiveFailures += 1;
      backoffUntil = now + backoffSeconds(FetchFailureKind.TRANSIENT, consecutiveFailures, nowDate) * 1000;
      continue;
    }
    consecutiveFailures = 0;
    // The provider publishes on its cadence, 7 minutes late one time in five.
    const cadence = profile.cadenceSeconds * 1000;
    const published = Math.floor(now / cadence) * cadence;
    const late = snapshotNumber % 5 === 0 ? 7 * 60_000 : 0;
    snapshotNumber += 1;
    latest = {
      snapshotId: `snapshot-${snapshotNumber}`,
      fetchedAt: nowDate,
      providerUpdatedAt: new Date(published),
      providerNextUpdateAt: new Date(published + cadence + late),
    };
  }
  return { calls, maximumPerDay: Math.max(...callsPerDay.values()) };
}

describe('a simulated month per plan stays far inside the budget', () => {
  it.each([
    [ProviderPlan.OPEN, 25, 70],
    [ProviderPlan.FREE, 25, 70],
    [ProviderPlan.PRO, 700, 1_500],
    [ProviderPlan.BUSINESS, 8_000, 12_000],
  ])('%s: scheduled calls in [%i, %i], under the monthly and daily budgets, even with failures', (plan, minimum, maximum) => {
    const profile = PROVIDER_PLAN_PROFILES[plan];
    for (const failureEvery of [0, 7]) {
      const { calls, maximumPerDay } = simulateMonth(profile, failureEvery);
      expect(calls).toBeGreaterThanOrEqual(minimum);
      expect(calls).toBeLessThanOrEqual(maximum);
      expect(calls).toBeLessThanOrEqual(profile.monthlyBudget);
      expect(maximumPerDay).toBeLessThanOrEqual(profile.dailyBudget);
      if (profile.monthlyQuota !== null) expect(profile.monthlyBudget).toBeLessThanOrEqual(profile.monthlyQuota * 0.8);
    }
  });
});
