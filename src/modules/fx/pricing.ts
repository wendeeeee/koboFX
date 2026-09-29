import Decimal from 'decimal.js';
import { InvariantViolationError } from '../../common/errors';
import { Dec, MoneyDecimal, RoundingPolicy, RoundingPurpose, dec, majorToExactMinor, minorToMajorDecimal } from '../../common/money';

export interface PricedCurrency {
  readonly code: string;
  readonly minorUnit: number;
}

export enum QuoteAmountMode {
  /** The user states how much they sell; the credit is derived (`ROUND_DOWN`). */
  SOURCE = 'SOURCE',
  /** The user states how much they receive; the debit is derived (`ROUND_UP`, §7.7 "buy $50 with NGN"). */
  TARGET = 'TARGET',
}

export interface PricingInput {
  readonly source: PricedCurrency;
  readonly target: PricedCurrency;
  /** USD-based reference mids: 1 USD = `sourceUsdRate` source = `targetUsdRate` target. */
  readonly sourceUsdRate: Dec;
  readonly targetUsdRate: Dec;
  /** The directional pair's spread (source → target). */
  readonly spreadBasisPoints: number;
  readonly mode: QuoteAmountMode;
  /** Minor units of the source (SOURCE mode) or the target (TARGET mode). */
  readonly amountMinor: bigint;
}

/**
 * Everything a conversion posts (design §5.6), in minor units: the source debited, the
 * target credited, the mid value of the source in the target currency, and the revenue
 * as their difference — so the target legs balance exactly by construction.
 */
export interface PricedConversion {
  readonly midRate: Dec;
  readonly clientRate: Dec;
  readonly sourceAmountMinor: bigint;
  readonly targetAmountMinor: bigint;
  readonly targetMidValueMinor: bigint;
  readonly revenueMinor: bigint;
  /** The exact (unrounded) target value at the client rate, for the residual's audit. */
  readonly exactClientTargetMinor: Dec;
  readonly exactMidTargetMinor: Dec;
}

const BASIS_POINTS = new MoneyDecimal(10_000);
const ONE = new MoneyDecimal(1);

function assertPositiveRate(name: string, rate: Dec): void {
  if (!rate.isFinite() || rate.lte(0)) throw new InvariantViolationError(`${name} must be a positive rate.`, { rate: rate.toString() });
}

function spreadFactor(spreadBasisPoints: number): Dec {
  if (!Number.isInteger(spreadBasisPoints) || spreadBasisPoints < 0 || spreadBasisPoints >= 10_000) {
    throw new InvariantViolationError('Spread must be an integer number of basis points in [0, 10000).', { spreadBasisPoints });
  }
  return ONE.minus(new MoneyDecimal(spreadBasisPoints).div(BASIS_POINTS));
}

/**
 * The reference mid A→B (target per 1 source), triangulated through USD:
 * `usdRate(B) / usdRate(A)` (design §4.3, §7.4). Legitimate ONLY because these are
 * reference mids, which invert by definition — it would be wrong applied to tradeable
 * bid/ask, and nothing here ever triangulates a client rate.
 */
export function triangulatedMid(sourceUsdRate: Dec, targetUsdRate: Dec): Dec {
  assertPositiveRate('sourceUsdRate', sourceUsdRate);
  assertPositiveRate('targetUsdRate', targetUsdRate);
  return targetUsdRate.div(sourceUsdRate);
}

/**
 * The directional client rate for source → target: `mid × (1 − spread)` (design §5.6,
 * which the golden test pins; §4.5's `mid × (1 + spread)` "buy" formula is superseded —
 * Phase 6 decision A.3). The reverse direction is priced by its own pair row, so the two
 * never invert into each other once a spread is applied.
 */
export function clientRateOf(mid: Dec, spreadBasisPoints: number): Dec {
  return mid.times(spreadFactor(spreadBasisPoints));
}

/**
 * Price a conversion (design §4.4, §4.5, §5.6). Full precision throughout, and exactly one
 * rounding per amount, through `RoundingPolicy`:
 *
 * - SOURCE mode: credit = `USER_CREDIT`(source × mid × (1 − spread)); mid value =
 *   `REVENUE`(source × mid).
 * - TARGET mode: debit = `USER_DEBIT`(target / clientRate); mid value = `REVENUE`(debit × mid).
 *
 * Revenue = mid value − credit: the rounding residual of both roundings is inside the
 * revenue figure, never dropped. Products are formed before the single division by the
 * source's USD rate, so an exact result stays exact.
 */
export function priceConversion(input: PricingInput, rounding: RoundingPolicy): PricedConversion {
  const { source, target, sourceUsdRate, targetUsdRate, spreadBasisPoints, mode, amountMinor } = input;
  if (source.code === target.code) throw new InvariantViolationError('Cannot price a conversion within one currency.');
  if (amountMinor <= 0n) throw new InvariantViolationError('A priced amount must be positive.', { amountMinor: amountMinor.toString() });
  const midRate = triangulatedMid(sourceUsdRate, targetUsdRate);
  const factor = spreadFactor(spreadBasisPoints);
  const clientRate = midRate.times(factor);

  // target (major) = source (major) × targetUsd / sourceUsd — multiply first, divide once.
  const targetMinorFor = (sourceMinor: bigint, applySpread: boolean): Dec => {
    const sourceMajor = minorToMajorDecimal(sourceMinor, source.minorUnit);
    const numerator = sourceMajor.times(targetUsdRate).times(applySpread ? factor : ONE);
    return majorToExactMinor(numerator.div(sourceUsdRate), target.minorUnit);
  };

  let sourceAmountMinor: bigint;
  let targetAmountMinor: bigint;
  let exactClientTargetMinor: Dec;
  if (mode === QuoteAmountMode.SOURCE) {
    sourceAmountMinor = amountMinor;
    exactClientTargetMinor = targetMinorFor(sourceAmountMinor, true);
    targetAmountMinor = rounding.round(exactClientTargetMinor, RoundingPurpose.USER_CREDIT).amountMinor;
  } else {
    targetAmountMinor = amountMinor;
    // source (major) = target (major) × sourceUsd / (targetUsd × factor)
    const targetMajor = minorToMajorDecimal(targetAmountMinor, target.minorUnit);
    const exactSourceMinor = majorToExactMinor(
      targetMajor.times(sourceUsdRate).div(targetUsdRate.times(factor)),
      source.minorUnit,
    );
    sourceAmountMinor = rounding.round(exactSourceMinor, RoundingPurpose.USER_DEBIT).amountMinor;
    exactClientTargetMinor = targetMinorFor(sourceAmountMinor, true);
  }
  const exactMidTargetMinor = targetMinorFor(sourceAmountMinor, false);
  const targetMidValueMinor = rounding.round(exactMidTargetMinor, RoundingPurpose.REVENUE).amountMinor;
  const revenueMinor = targetMidValueMinor - targetAmountMinor;
  if (revenueMinor < 0n) {
    // Only reachable with a misconfigured rounding policy (e.g. USER_CREDIT rounding up past the mid).
    throw new InvariantViolationError('Pricing would credit more than the mid value: revenue is negative.', {
      targetMidValueMinor: targetMidValueMinor.toString(),
      targetAmountMinor: targetAmountMinor.toString(),
    });
  }
  return {
    midRate,
    clientRate,
    sourceAmountMinor,
    targetAmountMinor,
    targetMidValueMinor,
    revenueMinor,
    exactClientTargetMinor,
    exactMidTargetMinor,
  };
}

/** Significant digits of a rate on the wire (display only — the amounts are authoritative). */
export const DISPLAY_RATE_SIGNIFICANT_DIGITS = 12;

/**
 * A rate as a plain decimal string for display (design §4.3: display only): 12
 * significant digits, `ROUND_HALF_EVEN`, never exponent notation. A fixed number of
 * decimal places would print NGN→USD (≈ 0.000752) with almost no information.
 */
export function displayRate(rate: Dec): string {
  return dec(rate).toSignificantDigits(DISPLAY_RATE_SIGNIFICANT_DIGITS, Decimal.ROUND_HALF_EVEN).toFixed();
}

/** A rate at full precision as a plain string (storage and provenance). */
export function exactRateString(rate: Dec): string {
  return dec(rate).toFixed();
}
