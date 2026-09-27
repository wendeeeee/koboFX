import fc from 'fast-check';
import { CurrencyMismatchError, InvalidAmountError, InvariantViolationError } from '../errors';
import { Currency } from './currency';
import { INT64_MAX, INT64_MIN } from './minor-units';
import { Money } from './money';

const CODES = ['NGN', 'USD', 'EUR', 'GBP', 'JPY', 'KWD'] as const;
const code = fc.constantFrom(...CODES);
const int64 = fc.bigInt({ min: INT64_MIN, max: INT64_MAX });
/** Small enough that sums of a few never overflow, so algebraic laws can be checked. */
const bounded = fc.bigInt({ min: -(2n ** 60n), max: 2n ** 60n });
const money = fc.tuple(int64, code).map(([a, c]) => Money.of(a, c));
const twoDifferentCodes = fc
  .tuple(code, code)
  .filter(([a, b]) => a !== b);

const currency = (c: string, minorUnit: number): Currency => ({
  code: c,
  name: c,
  symbol: c,
  minorUnit,
  isActive: true,
});

describe('Money', () => {
  describe('cross-currency arithmetic is unrepresentable', () => {
    it('add / subtract / compare throw for ANY pair of different currencies', () => {
      fc.assert(
        fc.property(int64, int64, twoDifferentCodes, (a, b, [ca, cb]) => {
          const x = Money.of(a, ca);
          const y = Money.of(b, cb);
          expect(() => x.add(y)).toThrow(CurrencyMismatchError);
          expect(() => x.subtract(y)).toThrow(CurrencyMismatchError);
          expect(() => x.compare(y)).toThrow(CurrencyMismatchError);
          expect(x.equals(y)).toBe(false);
        }),
      );
    });

    it('a mismatch is an invariant violation (our bug), not a client error', () => {
      expect(() => Money.of(1n, 'NGN').add(Money.of(1n, 'USD'))).toThrow(InvariantViolationError);
    });
  });

  describe('algebra within one currency', () => {
    it('add is commutative and associative', () => {
      fc.assert(
        fc.property(bounded, bounded, bounded, code, (a, b, c, ccy) => {
          const [x, y, z] = [a, b, c].map((v) => Money.of(v, ccy));
          expect(x.add(y).equals(y.add(x))).toBe(true);
          expect(x.add(y).add(z).equals(x.add(y.add(z)))).toBe(true);
        }),
      );
    });

    it('subtract undoes add; negate is an involution; zero is the identity', () => {
      fc.assert(
        fc.property(bounded, bounded, code, (a, b, ccy) => {
          const x = Money.of(a, ccy);
          const y = Money.of(b, ccy);
          expect(x.add(y).subtract(y).equals(x)).toBe(true);
          expect(x.negate().negate().equals(x)).toBe(true);
          expect(x.add(Money.zero(ccy)).equals(x)).toBe(true);
          expect(x.add(x.negate()).isZero()).toBe(true);
        }),
      );
    });

    it('summing in any order gives the same total (nothing minted, nothing lost)', () => {
      fc.assert(
        fc.property(fc.array(bounded, { maxLength: 30 }), code, (amounts, ccy) => {
          const items = amounts.map((a) => Money.of(a, ccy));
          const forward = items.reduce((s, m) => s.add(m), Money.zero(ccy));
          const backward = [...items].reverse().reduce((s, m) => s.add(m), Money.zero(ccy));
          expect(forward.equals(backward)).toBe(true);
          expect(forward.amountMinor).toBe(amounts.reduce((s, a) => s + a, 0n));
        }),
      );
    });

    it('compare agrees with bigint ordering', () => {
      fc.assert(
        fc.property(int64, int64, code, (a, b, ccy) => {
          const expected = a === b ? 0 : a < b ? -1 : 1;
          expect(Money.of(a, ccy).compare(Money.of(b, ccy))).toBe(expected);
        }),
      );
    });
  });

  describe('range and representation', () => {
    it('negative balances are representable (design §6.2)', () => {
      const overdrawn = Money.of(100n, 'NGN').subtract(Money.of(250n, 'NGN'));
      expect(overdrawn.isNegative()).toBe(true);
      expect(overdrawn.amountMinor).toBe(-150n);
      expect(overdrawn.abs().amountMinor).toBe(150n);
    });

    it('overflow throws instead of wrapping', () => {
      const max = Money.of(INT64_MAX, 'NGN');
      expect(() => max.add(Money.of(1n, 'NGN'))).toThrow(InvalidAmountError);
      expect(() => Money.of(INT64_MIN, 'NGN').negate()).toThrow(InvalidAmountError);
      expect(() => Money.of(INT64_MAX + 1n, 'NGN')).toThrow(InvalidAmountError);
    });

    it('refuses a JS number as an amount', () => {
      expect(() => Money.of(100 as unknown as bigint, 'NGN')).toThrow(InvariantViolationError);
      expect(() => Money.of(0.1 as unknown as bigint, 'NGN')).toThrow(InvariantViolationError);
    });

    it('refuses malformed currency codes', () => {
      for (const bad of ['ngn', 'NG', 'NGNN', '', '12A']) {
        expect(() => Money.of(1n, bad)).toThrow(InvariantViolationError);
      }
    });
  });

  describe('round-trip: Money → JSON string → Money', () => {
    it('is lossless for every BIGINT value, including beyond Number.MAX_SAFE_INTEGER', () => {
      fc.assert(
        fc.property(money, (m) => {
          const wire = JSON.parse(JSON.stringify(m)) as { currency: string; amountMinor: string };
          expect(typeof wire.amountMinor).toBe('string');
          expect(Money.fromMinorString(wire.amountMinor, wire.currency).equals(m)).toBe(true);
        }),
      );
    });

    it('rejects anything that is not a canonical integer string', () => {
      for (const bad of ['1.5', '1e3', ' 1', '01', '-0', '', '+1', '0x10', '9223372036854775808']) {
        expect(() => Money.fromMinorString(bad, 'NGN')).toThrow(InvalidAmountError);
      }
    });
  });

  describe('toView uses the currency minor unit — never a hardcoded 100', () => {
    it.each([
      ['NGN', 2, 125000n, '1250.00'],
      ['JPY', 0, 125n, '125'],
      ['KWD', 3, 1234n, '1.234'],
      ['USD', 2, -5n, '-0.05'],
    ])('%s (minor unit %d): %s → %s', (ccy, minorUnit, amountMinor, amount) => {
      expect(Money.of(amountMinor, ccy).toView(currency(ccy, minorUnit))).toEqual({
        currency: ccy,
        amountMinor: amountMinor.toString(),
        amount,
      });
    });

    it('refuses to format with the wrong currency', () => {
      expect(() => Money.of(1n, 'NGN').toView(currency('USD', 2))).toThrow(CurrencyMismatchError);
    });
  });
});
