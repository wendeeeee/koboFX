import Decimal from 'decimal.js';
import { InvariantViolationError } from '../../common/errors';
import { Dec, MoneyDecimal, RoundingPolicy, RoundingPurpose, dec, majorToExactMinor, minorToMajorDecimal } from '../../common/money';

export interface PricedCurrency {
  readonly code: string;
  readonly minorUnit: number;
}

export enum QuoteAmountMode {
  SOURCE = 'SOURCE',
  TARGET = 'TARGET',
}

export interface PricingInput {
  readonly source: PricedCurrency;
  readonly target: PricedCurrency;
  readonly sourceUsdRate: Dec;
  readonly targetUsdRate: Dec;
  readonly spreadBasisPoints: number;
  readonly mode: QuoteAmountMode;
  readonly amountMinor: bigint;
}

export interface PricedConversion {
  readonly midRate: Dec;
  readonly clientRate: Dec;
  readonly sourceAmountMinor: bigint;
  readonly targetAmountMinor: bigint;
  readonly targetMidValueMinor: bigint;
  readonly revenueMinor: bigint;
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

export function triangulatedMid(sourceUsdRate: Dec, targetUsdRate: Dec): Dec {
  assertPositiveRate('sourceUsdRate', sourceUsdRate);
  assertPositiveRate('targetUsdRate', targetUsdRate);
  return targetUsdRate.div(sourceUsdRate);
}

export function clientRateOf(mid: Dec, spreadBasisPoints: number): Dec {
  return mid.times(spreadFactor(spreadBasisPoints));
}

export function priceConversion(input: PricingInput, rounding: RoundingPolicy): PricedConversion {
  const { source, target, sourceUsdRate, targetUsdRate, spreadBasisPoints, mode, amountMinor } = input;
  if (source.code === target.code) throw new InvariantViolationError('Cannot price a conversion within one currency.');
  if (amountMinor <= 0n) throw new InvariantViolationError('A priced amount must be positive.', { amountMinor: amountMinor.toString() });
  const midRate = triangulatedMid(sourceUsdRate, targetUsdRate);
  const factor = spreadFactor(spreadBasisPoints);
  const clientRate = midRate.times(factor);

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

export const DISPLAY_RATE_SIGNIFICANT_DIGITS = 12;

export function displayRate(rate: Dec): string {
  return dec(rate).toSignificantDigits(DISPLAY_RATE_SIGNIFICANT_DIGITS, Decimal.ROUND_HALF_EVEN).toFixed();
}

export function exactRateString(rate: Dec): string {
  return dec(rate).toFixed();
}
