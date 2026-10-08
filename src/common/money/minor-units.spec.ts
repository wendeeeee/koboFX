import fc from 'fast-check';
import { InvalidAmountError, InvariantViolationError } from '../errors';
import { dec } from './decimal';
import {
  INT64_MAX,
  INT64_MIN,
  majorToExactMinor,
  minorToMajorDecimal,
  parseMajorString,
  parseMinorString,
  toMajorString,
} from './minor-units';

const int64 = fc.bigInt({ min: INT64_MIN, max: INT64_MAX });
const minorUnit = fc.integer({ min: 0, max: 4 });

describe('minor ⇄ major conversion', () => {
  it('round-trips every BIGINT for minor units 0–4 (JPY 0, NGN 2, KWD 3, CLF 4)', () => {
    fc.assert(
      fc.property(int64, minorUnit, (amount, mu) => {
        const major = toMajorString(amount, mu);
        expect(parseMajorString(major, mu)).toBe(amount);
      }),
      { numRuns: 2000 },
    );
  });

  it('produces exactly `minorUnit` fraction digits', () => {
    fc.assert(
      fc.property(int64, minorUnit, (amount, mu) => {
        const major = toMajorString(amount, mu);
        const fraction = major.split('.')[1];
        expect(fraction?.length ?? 0).toBe(mu);
      }),
    );
  });

  it.each([
    [125000n, 2, '1250.00'],
    [125n, 0, '125'],
    [1234n, 3, '1.234'],
    [-5n, 2, '-0.05'],
    [0n, 3, '0.000'],
    [INT64_MAX, 2, '92233720368547758.07'],
  ])('toMajorString(%s, %d) === %s', (amount, mu, expected) => {
    expect(toMajorString(amount, mu)).toBe(expected);
  });

  it('never rounds on parse: excess precision is rejected unless it is zeros', () => {
    expect(parseMajorString('1.500', 2)).toBe(150n);
    expect(parseMajorString('7', 0)).toBe(7n);
    expect(() => parseMajorString('1.001', 2)).toThrow(InvalidAmountError);
    expect(() => parseMajorString('1.5', 0)).toThrow(InvalidAmountError);
  });

  it('rejects non-canonical and exotic inputs', () => {
    for (const bad of ['1e5', '.5', '1.', '+1', '', ' 1', '0x1', '١', 'NaN', 'Infinity', '01.00']) {
      expect(() => parseMajorString(bad, 2)).toThrow(InvalidAmountError);
    }
    expect(() => parseMajorString('92233720368547758.08', 2)).toThrow(InvalidAmountError);
  });

  it('rejects an invalid minor unit loudly', () => {
    expect(() => toMajorString(1n, 5)).toThrow(InvariantViolationError);
    expect(() => toMajorString(1n, -1)).toThrow(InvariantViolationError);
    expect(() => toMajorString(1n, 1.5)).toThrow(InvariantViolationError);
  });

  it('minor → exact major Decimal → exact minor is lossless', () => {
    fc.assert(
      fc.property(int64, minorUnit, (amount, mu) => {
        const back = majorToExactMinor(minorToMajorDecimal(amount, mu), mu);
        expect(back.equals(dec(amount))).toBe(true);
        expect(back.isInteger()).toBe(true);
      }),
    );
  });

  describe('parseMinorString (wire amounts)', () => {
    it('round-trips every BIGINT', () => {
      fc.assert(fc.property(int64, (a) => expect(parseMinorString(a.toString())).toBe(a)));
    });

    it('rejects anything but canonical integers within BIGINT', () => {
      for (const bad of ['1.0', '1e2', '-0', '00', '', '9223372036854775808', '-9223372036854775809']) {
        expect(() => parseMinorString(bad)).toThrow(InvalidAmountError);
      }
      expect(() => parseMinorString(42 as unknown as string)).toThrow(InvalidAmountError);
    });
  });
});
