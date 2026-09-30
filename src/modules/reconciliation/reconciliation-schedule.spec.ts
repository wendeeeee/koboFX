import { ReconciliationRunKind, dailyPeriodDue, hourlyPeriodDue, missedPeriods, periodDue } from './reconciliation-schedule';

const schedule = { internalAt: { hour: 1, minute: 0 }, externalDailyAt: { hour: 2, minute: 30 }, externalHourlyMinute: 15 };

describe('reconciliation schedule (UTC)', () => {
  it('a daily period is today once its time has passed, else yesterday', () => {
    expect(dailyPeriodDue(new Date('2026-09-29T00:59:59Z'), schedule.internalAt)).toBe('2026-09-28');
    expect(dailyPeriodDue(new Date('2026-09-29T01:00:00Z'), schedule.internalAt)).toBe('2026-09-29');
    expect(dailyPeriodDue(new Date('2026-09-29T23:59:59Z'), schedule.internalAt)).toBe('2026-09-29');
    expect(periodDue(ReconciliationRunKind.EXTERNAL_DAILY, new Date('2026-09-29T02:29:00Z'), schedule)).toBe('2026-09-28');
    expect(periodDue(ReconciliationRunKind.EXTERNAL_DAILY, new Date('2026-09-29T02:30:00Z'), schedule)).toBe('2026-09-29');
  });

  it('an hourly period is this hour once its minute has passed, else the previous hour (across midnight too)', () => {
    expect(hourlyPeriodDue(new Date('2026-09-29T13:14:59Z'), 15)).toBe('2026-09-29T12');
    expect(hourlyPeriodDue(new Date('2026-09-29T13:15:00Z'), 15)).toBe('2026-09-29T13');
    expect(periodDue(ReconciliationRunKind.EXTERNAL_HOURLY, new Date('2026-09-30T00:05:00Z'), schedule)).toBe('2026-09-29T23');
    expect(periodDue(ReconciliationRunKind.INTERNAL, new Date('2026-09-30T00:05:00Z'), schedule)).toBe('2026-09-29');
  });

  it('missed periods: every period strictly between the last and the current, daily and hourly', () => {
    expect(missedPeriods('2026-09-25', '2026-09-29')).toEqual(['2026-09-26', '2026-09-27', '2026-09-28']);
    expect(missedPeriods('2026-09-28', '2026-09-29')).toEqual([]);
    expect(missedPeriods('2026-09-29T22', '2026-09-30T01')).toEqual(['2026-09-29T23', '2026-09-30T00']);
    expect(missedPeriods('2026-01-01', '2027-06-01', 5)).toHaveLength(5);
  });
});
