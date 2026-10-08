
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
