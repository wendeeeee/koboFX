/**
 * An INDEPENDENT oracle for the T+X settlement deadline (Phase 9 plan §F), for integration and
 * property tests. It shares no code with `src/modules/reconciliation/settlement-window.ts`, so a
 * mutated window cannot move the tests' expectation along with the code (it did, once: both window
 * mutants survived while the tests imported the function under test).
 *
 * Rule, restated from the plan: take the capture's UTC calendar date; step forward one calendar day
 * at a time, counting only Monday–Friday, until `businessDays` have been counted; the deadline is
 * midnight UTC at the END of that day, plus `graceHours`.
 */
export function expectedSettlementDeadline(capturedAt: Date, businessDays: number, graceHours: number): Date {
  const cursor = new Date(Date.UTC(capturedAt.getUTCFullYear(), capturedAt.getUTCMonth(), capturedAt.getUTCDate()));
  let counted = 0;
  while (counted < businessDays) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) counted += 1;
  }
  cursor.setUTCDate(cursor.getUTCDate() + 1); // the END of that day
  cursor.setUTCHours(cursor.getUTCHours() + graceHours);
  return cursor;
}
