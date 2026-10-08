import { TimeOfDay } from '../../config/configuration';

export enum ReconciliationRunKind {
  INTERNAL = 'INTERNAL',
  EXTERNAL_DAILY = 'EXTERNAL_DAILY',
  EXTERNAL_HOURLY = 'EXTERNAL_HOURLY',
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function dateKey(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function hourKey(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 13);
}

/**
 * The daily period whose run is due at `now` (UTC): today's date once `at` has passed, else
 * yesterday's. A run for date D covers the books as of the moment it runs (the checks are
 * cumulative), but there is exactly one per date.
 */
export function dailyPeriodDue(now: Date, at: TimeOfDay): string {
  const midnight = Math.floor(now.getTime() / DAY) * DAY;
  const dueToday = midnight + at.hour * HOUR + at.minute * 60_000;
  return dateKey(now.getTime() >= dueToday ? midnight : midnight - DAY);
}

/** The hourly period (`YYYY-MM-DDTHH`) whose sweep is due at `now`: this hour once `minute` has passed. */
export function hourlyPeriodDue(now: Date, minute: number): string {
  const hourStart = Math.floor(now.getTime() / HOUR) * HOUR;
  return hourKey(now.getTime() >= hourStart + minute * 60_000 ? hourStart : hourStart - HOUR);
}

export function periodDue(kind: ReconciliationRunKind, now: Date, schedule: { internalAt: TimeOfDay; externalDailyAt: TimeOfDay; externalHourlyMinute: number }): string {
  switch (kind) {
    case ReconciliationRunKind.INTERNAL:
      return dailyPeriodDue(now, schedule.internalAt);
    case ReconciliationRunKind.EXTERNAL_DAILY:
      return dailyPeriodDue(now, schedule.externalDailyAt);
    case ReconciliationRunKind.EXTERNAL_HOURLY:
      return hourlyPeriodDue(now, schedule.externalHourlyMinute);
  }
}

function periodStart(key: string): number {
  return Date.parse(key.length === 10 ? `${key}T00:00:00Z` : `${key}:00:00Z`);
}

/**
 * The periods strictly between `last` and `current` — the ones nobody ran (the worker was down).
 * They are recorded as MISSED so the gap is visible; the current run catches up (the checks are
 * cumulative). Capped, so a long outage cannot flood the table.
 */
export function missedPeriods(last: string, current: string, maximum = 400): string[] {
  const step = current.length === 10 ? DAY : HOUR;
  const toKey = current.length === 10 ? dateKey : hourKey;
  const missed: string[] = [];
  for (let at = periodStart(last) + step; at < periodStart(current) && missed.length < maximum; at += step) {
    missed.push(toKey(at));
  }
  return missed;
}
