import { SettlementWindow } from '../../config/configuration';

const DAY_MILLISECONDS = 24 * 3600 * 1000;
const HOUR_MILLISECONDS = 3600 * 1000;

function isWeekend(utcMidnight: number): boolean {
  const day = new Date(utcMidnight).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * When a deposit captured at `capturedAt` must have been settled (handbook: "the T+X delay is
 * baked into the process"): the capture's UTC date, plus `businessDays` weekdays (Mon–Fri; no
 * holiday calendar — the grace absorbs a holiday), to the END of that day, plus `graceHours`.
 * A deposit captured on a Saturday counts from the Saturday: T+2 is Tuesday.
 */
export function settlementDeadline(capturedAt: Date, window: SettlementWindow): Date {
  let day = Math.floor(capturedAt.getTime() / DAY_MILLISECONDS) * DAY_MILLISECONDS;
  let remaining = window.businessDays;
  while (remaining > 0) {
    day += DAY_MILLISECONDS;
    if (!isWeekend(day)) remaining -= 1;
  }
  return new Date(day + DAY_MILLISECONDS + window.graceHours * HOUR_MILLISECONDS);
}

/** Unsettled at `now` is expected up to and including the deadline; strictly after it, a break. */
export function isPastSettlementWindow(capturedAt: Date, window: SettlementWindow, now: Date): boolean {
  return now.getTime() > settlementDeadline(capturedAt, window).getTime();
}
