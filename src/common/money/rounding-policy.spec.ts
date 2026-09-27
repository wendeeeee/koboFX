import fc from 'fast-check';
import { InvalidAmountError, InvariantViolationError } from '../errors';
import { Dec, MoneyDecimal, dec } from './decimal';
import { INT64_MAX, INT64_MIN, majorToExactMinor } from './minor-units';
import { RoundingConfig, RoundingPolicy, RoundingPurpose, RoundingStrategy } from './rounding-policy';

const ALL = Object.values(RoundingStrategy);

/**
 * Exact decimals n / 10^scale with n in BIGINT range and up to 12 dp — built from
 * bigints, never floats. Every such value rounds to something that still fits BIGINT
 * (out-of-range input is covered separately below).
 */
const exactDecimal: fc.Arbitrary<Dec> = fc
  .tuple(fc.bigInt({ min: INT64_MIN, max: INT64_MAX }), fc.integer({ min: 0, max: 12 }))
  .map(([n, scale]) => dec(n).div(new MoneyDecimal(10).pow(scale)));

const nonNegative = exactDecimal.map((d) => d.abs());

const CONFIG: RoundingConfig = {
  [RoundingPurpose.USER_CREDIT]: RoundingStrategy.ROUND_DOWN,
  [RoundingPurpose.REVENUE]: RoundingStrategy.ROUND_HALF_EVEN,
  [RoundingPurpose.FEE]: RoundingStrategy.ROUND_HALF_EVEN,
};

describe('RoundingPolicy', () => {
  describe('the residual is tracked, never dropped (design §4.4)', () => {
    it('for EVERY strategy: rounded + residual === exact, exactly, and |residual| < 1', () => {
      fc.assert(
        fc.property(exactDecimal, fc.constantFrom(...ALL), (exact, strategy) => {
          const r = RoundingPolicy.apply(exact, strategy);
          expect(dec(r.amountMinor).plus(r.residualMinor).equals(exact)).toBe(true);
          expect(r.residualMinor.abs().lessThan(1)).toBe(true);
          expect(r.strategy).toBe(strategy);
        }),
        { numRuns: 3000 },
      );
    });

    it('integers are never changed by rounding', () => {
      fc.assert(
        fc.property(fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }), fc.constantFrom(...ALL), (n, s) => {
          const r = RoundingPolicy.apply(dec(n), s);
          expect(r.amountMinor).toBe(n);
          expect(r.residualMinor.isZero()).toBe(true);
        }),
      );
    });
  });

  describe('each strategy does what its name says', () => {
    it('ROUND_DOWN never increases magnitude — a credit is never more than was debited', () => {
      fc.assert(
        fc.property(exactDecimal, (exact) => {
          const r = RoundingPolicy.apply(exact, RoundingStrategy.ROUND_DOWN);
          expect(dec(r.amountMinor).abs().lessThanOrEqualTo(exact.abs())).toBe(true);
        }),
      );
    });

    it('FLOOR ≤ exact ≤ CEIL, and they differ by at most one minor unit', () => {
      fc.assert(
        fc.property(exactDecimal, (exact) => {
          const floor = RoundingPolicy.apply(exact, RoundingStrategy.ROUND_FLOOR).amountMinor;
          const ceil = RoundingPolicy.apply(exact, RoundingStrategy.ROUND_CEIL).amountMinor;
          expect(dec(floor).lessThanOrEqualTo(exact)).toBe(true);
          expect(dec(ceil).greaterThanOrEqualTo(exact)).toBe(true);
          expect(ceil - floor).toBe(exact.isInteger() ? 0n : 1n);
        }),
      );
    });

    it('HALF_EVEN picks the nearest integer, and the even one on a tie', () => {
      fc.assert(
        fc.property(exactDecimal, (exact) => {
          const r = RoundingPolicy.apply(exact, RoundingStrategy.ROUND_HALF_EVEN);
          expect(r.residualMinor.abs().lessThanOrEqualTo(new MoneyDecimal('0.5'))).toBe(true);
          if (r.residualMinor.abs().equals(new MoneyDecimal('0.5'))) {
            expect(r.amountMinor % 2n).toBe(0n);
          }
        }),
      );
      expect(RoundingPolicy.apply(dec('2.5'), RoundingStrategy.ROUND_HALF_EVEN).amountMinor).toBe(2n);
      expect(RoundingPolicy.apply(dec('3.5'), RoundingStrategy.ROUND_HALF_EVEN).amountMinor).toBe(4n);
      expect(RoundingPolicy.apply(dec('-2.5'), RoundingStrategy.ROUND_HALF_EVEN).amountMinor).toBe(-2n);
      expect(RoundingPolicy.apply(dec('2.5'), RoundingStrategy.ROUND_HALF_UP).amountMinor).toBe(3n);
    });
  });

  describe('the conversion pattern of design §5.6 cannot mint money', () => {
    /**
     * credit = ROUND_DOWN(exactMid × (1 − spread)), midValue = ROUND_HALF_EVEN(exactMid),
     * revenue = midValue − credit. For the books to balance with a POSITIVE revenue
     * entry, revenue must never be negative — for any amount and any spread.
     */
    it('for any non-negative amount and spread, ROUND_DOWN(client) ≤ ROUND_HALF_EVEN(mid)', () => {
      fc.assert(
        fc.property(nonNegative, fc.integer({ min: 0, max: 5000 }), (exactMid, spreadBps) => {
          const factor = new MoneyDecimal(1).minus(new MoneyDecimal(spreadBps).div(10_000));
          const credit = RoundingPolicy.apply(exactMid.times(factor), RoundingStrategy.ROUND_DOWN);
          const midValue = RoundingPolicy.apply(exactMid, RoundingStrategy.ROUND_HALF_EVEN);
          const revenue = midValue.amountMinor - credit.amountMinor;
          expect(revenue >= 0n).toBe(true);
          expect(credit.amountMinor + revenue).toBe(midValue.amountMinor);
        }),
        { numRuns: 3000 },
      );
    });

    it('golden: reproduces the worked example (₦1,000,000 at 1,530.50, 50 bps)', () => {
      const policy = new RoundingPolicy(CONFIG);
      const exactMidUsd = dec('1000000').div(dec('1530.50'));
      const exactClientUsd = exactMidUsd.times(new MoneyDecimal(1).minus(dec('0.005')));

      const credit = policy.round(majorToExactMinor(exactClientUsd, 2), RoundingPurpose.USER_CREDIT);
      const midValue = policy.round(majorToExactMinor(exactMidUsd, 2), RoundingPurpose.REVENUE);

      expect(credit.amountMinor).toBe(65_011n);
      expect(midValue.amountMinor).toBe(65_338n);
      expect(midValue.amountMinor - credit.amountMinor).toBe(327n);
      expect(credit.strategy).toBe(RoundingStrategy.ROUND_DOWN);
      expect(midValue.strategy).toBe(RoundingStrategy.ROUND_HALF_EVEN);
    });
  });

  describe('configuration', () => {
    it('resolves the strategy per purpose from config', () => {
      const policy = new RoundingPolicy({ ...CONFIG, [RoundingPurpose.FEE]: RoundingStrategy.ROUND_UP });
      expect(policy.strategyFor(RoundingPurpose.FEE)).toBe(RoundingStrategy.ROUND_UP);
      expect(policy.round(dec('1.1'), RoundingPurpose.FEE).amountMinor).toBe(2n);
      expect(policy.round(dec('1.9'), RoundingPurpose.USER_CREDIT).amountMinor).toBe(1n);
    });

    it('refuses to be built with a purpose missing', () => {
      const partial = { [RoundingPurpose.USER_CREDIT]: RoundingStrategy.ROUND_DOWN } as RoundingConfig;
      expect(() => new RoundingPolicy(partial)).toThrow(InvariantViolationError);
    });
  });

  describe('failure modes are loud', () => {
    it('rejects non-finite input', () => {
      expect(() =>
        RoundingPolicy.apply(new MoneyDecimal(1).div(0), RoundingStrategy.ROUND_DOWN),
      ).toThrow(InvariantViolationError);
    });

    it('rejects a result that does not fit BIGINT', () => {
      expect(() => RoundingPolicy.apply(dec(10n ** 20n), RoundingStrategy.ROUND_DOWN)).toThrow(
        InvalidAmountError,
      );
    });

    it('rejects an unknown strategy', () => {
      expect(() => RoundingPolicy.apply(dec('1.5'), 'BANKERS' as RoundingStrategy)).toThrow(
        InvariantViolationError,
      );
    });
  });
});
