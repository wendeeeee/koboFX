import { isPastSettlementWindow, settlementDeadline } from './settlement-window';

const T2 = { businessDays: 2, graceHours: 24 };
const SECOND = 1000;

describe('settlementDeadline (T+X, UTC business days, + grace)', () => {
  it.each([
    // captured                       window                        deadline (end of T+X day + grace)
    ['2026-09-28T10:00:00Z', T2, '2026-10-02T00:00:00Z'], // Mon → Wed, end of Wed = Thu 00:00, + 24h = Fri 00:00
    ['2026-10-01T23:59:59Z', T2, '2026-10-07T00:00:00Z'], // Thu → Mon (skips the weekend), end = Tue 00:00, + 24h
    ['2026-10-03T12:00:00Z', T2, '2026-10-08T00:00:00Z'], // Saturday counts from Saturday: T+2 is Tuesday, end = Wed 00:00, + 24h
    ['2026-09-28T10:00:00Z', { businessDays: 0, graceHours: 0 }, '2026-09-29T00:00:00Z'], // same-day settlement
    ['2026-10-02T08:00:00Z', { businessDays: 1, graceHours: 6 }, '2026-10-06T06:00:00Z'], // Fri → Mon, + 6h
  ])('captured %s with %j → %s', (captured, window, deadline) => {
    expect(settlementDeadline(new Date(captured), window).toISOString()).toBe(new Date(deadline).toISOString());
  });

  it('the edge: one second inside the window is expected, one second past it is a break', () => {
    const captured = new Date('2026-09-28T10:00:00Z');
    const deadline = settlementDeadline(captured, T2).getTime();
    expect(isPastSettlementWindow(captured, T2, new Date(deadline - SECOND))).toBe(false);
    expect(isPastSettlementWindow(captured, T2, new Date(deadline))).toBe(false);
    expect(isPastSettlementWindow(captured, T2, new Date(deadline + SECOND))).toBe(true);
  });

  it('a later capture never has an earlier deadline (monotone)', () => {
    let previous = 0;
    for (let hour = 0; hour < 24 * 14; hour += 5) {
      const deadline = settlementDeadline(new Date(Date.UTC(2026, 8, 28) + hour * 3600 * 1000), T2).getTime();
      expect(deadline).toBeGreaterThanOrEqual(previous);
      previous = deadline;
    }
  });
});
