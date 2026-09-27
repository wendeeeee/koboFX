import { InvariantViolationError } from '../errors';
import { MoneyDecimal, dec } from './decimal';

describe('dec', () => {
  it('builds from strings and bigints only', () => {
    expect(dec('1530.50').toString()).toBe('1530.5');
    expect(dec(9223372036854775807n).toFixed()).toBe('9223372036854775807');
    expect(() => dec(0.1 as unknown as string)).toThrow(InvariantViolationError);
  });

  it('rejects exponent notation and non-numbers', () => {
    for (const bad of ['1e5', 'NaN', 'Infinity', '', '.5', '1.', '0x1', '--1']) {
      expect(() => dec(bad)).toThrow(InvariantViolationError);
    }
  });

  it('keeps 34 significant digits and prints in plain notation', () => {
    expect(MoneyDecimal.precision).toBe(34);
    expect(dec('0.0000000000001').toString()).toBe('0.0000000000001');
    expect(dec('100000000000000000000000').toString()).toBe('100000000000000000000000');
    // 1/3 carries 34 significant digits, not 15-17 like a double.
    expect(dec('1').div(dec('3')).toString()).toBe(`0.${'3'.repeat(34)}`);
  });

  it('does not suffer binary floating-point error', () => {
    expect(dec('0.1').plus(dec('0.2')).equals(dec('0.3'))).toBe(true);
  });
});
