import { currencyOfAccountCode, driftByCurrency } from './drift';

describe('driftByCurrency', () => {
  it('sums ABSOLUTE differences per currency: +5 and −5 is 10 of drift, never 0', () => {
    const drift = driftByCurrency([
      { currency: 'NGN', differenceMinor: 5n },
      { currency: 'NGN', differenceMinor: -5n },
      { currency: 'USD', differenceMinor: -3n },
    ]);
    expect([...drift.entries()]).toEqual([
      ['NGN', 10n],
      ['USD', 3n],
    ]);
  });

  it('never sums across currencies, and reports every listed currency (0 when clean)', () => {
    const drift = driftByCurrency([{ currency: 'JPY', differenceMinor: 1n }], ['EUR', 'JPY', 'NGN']);
    expect(Object.fromEntries(drift)).toEqual({ EUR: 0n, JPY: 1n, NGN: 0n });
  });
});

describe('currencyOfAccountCode', () => {
  it('reads the currency from user and internal account codes', () => {
    expect(currencyOfAccountCode('USER:0f0f0f0f-0000-4000-8000-000000000000:NGN')).toBe('NGN');
    expect(currencyOfAccountCode('PSP_RECEIVABLE:USD')).toBe('USD');
    expect(currencyOfAccountCode('EXPENSE:PSP_FEES:KWD')).toBe('KWD');
    expect(() => currencyOfAccountCode('BROKEN')).toThrow();
  });
});
