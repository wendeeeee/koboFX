import { InvariantViolationError } from '../../common/errors';
import { Dec, Money, MoneyDecimal, isInt64, majorToExactMinor, minorToMajorDecimal } from '../../common/money';
import { PricedCurrency, displayRate } from '../fx/pricing';
import { EntryDirection, LedgerEntryDraft } from '../ledger/ledger.types';

export interface ConversionAmounts {
  readonly sourceAmountMinor: bigint;
  readonly targetAmountMinor: bigint;
  readonly targetMidValueMinor: bigint;
  readonly revenueMinor: bigint;
}

export interface ConversionLegs {
  readonly source: PricedCurrency;
  readonly target: PricedCurrency;
  readonly sourceAccountId: string;
  readonly targetAccountId: string;
  readonly amounts: ConversionAmounts;
}


export function assertConversionAmounts(amounts: ConversionAmounts): void {
  const { sourceAmountMinor, targetAmountMinor, targetMidValueMinor, revenueMinor } = amounts;
  const details = {
    sourceAmountMinor: sourceAmountMinor.toString(),
    targetAmountMinor: targetAmountMinor.toString(),
    targetMidValueMinor: targetMidValueMinor.toString(),
    revenueMinor: revenueMinor.toString(),
  };
  if (![sourceAmountMinor, targetAmountMinor, targetMidValueMinor, revenueMinor].every(isInt64)) {
    throw new InvariantViolationError('A conversion amount is outside the BIGINT range.', details);
  }
  if (sourceAmountMinor <= 0n || targetAmountMinor <= 0n || revenueMinor < 0n) {
    throw new InvariantViolationError('A conversion needs a positive debit and credit and a non-negative revenue.', details);
  }
  if (targetAmountMinor + revenueMinor !== targetMidValueMinor) {
    throw new InvariantViolationError('The target legs do not balance: credit + revenue must equal the mid value.', details);
  }
}


export function conversionEntries(legs: ConversionLegs): LedgerEntryDraft[] {
  assertConversionAmounts(legs.amounts);
  const { source, target, amounts } = legs;
  const entries: LedgerEntryDraft[] = [
    { account: { accountId: legs.sourceAccountId }, direction: EntryDirection.DEBIT, amount: Money.of(amounts.sourceAmountMinor, source.code) },
    { account: { systemAccount: 'FX_POSITION' }, direction: EntryDirection.CREDIT, amount: Money.of(amounts.sourceAmountMinor, source.code) },
    { account: { systemAccount: 'FX_POSITION' }, direction: EntryDirection.DEBIT, amount: Money.of(amounts.targetMidValueMinor, target.code) },
    { account: { accountId: legs.targetAccountId }, direction: EntryDirection.CREDIT, amount: Money.of(amounts.targetAmountMinor, target.code) },
  ];
  if (amounts.revenueMinor > 0n) {
    entries.push({
      account: { systemAccount: 'REVENUE:FX_SPREAD' },
      direction: EntryDirection.CREDIT,
      amount: Money.of(amounts.revenueMinor, target.code),
    });
  }
  return entries;
}


export function effectiveRateOf(source: PricedCurrency, sourceAmountMinor: bigint, target: PricedCurrency, targetAmountMinor: bigint): Dec {
  return minorToMajorDecimal(targetAmountMinor, target.minorUnit).div(minorToMajorDecimal(sourceAmountMinor, source.minorUnit));
}


export function rateDisplayOf(source: PricedCurrency, sourceAmountMinor: bigint, target: PricedCurrency, targetAmountMinor: bigint): string {
  return displayRate(effectiveRateOf(source, sourceAmountMinor, target, targetAmountMinor));
}


export function rateDisplayToleranceMinor(targetAmountMinor: bigint): bigint {
  const scaled = new MoneyDecimal(targetAmountMinor.toString()).times('1e-11').ceil();
  const tolerance = BigInt(scaled.toFixed());
  return tolerance > 1n ? tolerance : 1n;
}


export function assertRateDisplayReproduces(
  rateDisplay: string,
  source: PricedCurrency,
  sourceAmountMinor: bigint,
  target: PricedCurrency,
  targetAmountMinor: bigint,
): void {
  const reproduced = majorToExactMinor(minorToMajorDecimal(sourceAmountMinor, source.minorUnit).times(rateDisplay), target.minorUnit);
  const gap = reproduced.minus(targetAmountMinor.toString()).abs();
  const tolerance = rateDisplayToleranceMinor(targetAmountMinor);
  if (gap.gt(tolerance.toString())) {
    throw new InvariantViolationError('The display rate does not reproduce the credited amount.', {
      rateDisplay,
      sourceAmountMinor: sourceAmountMinor.toString(),
      targetAmountMinor: targetAmountMinor.toString(),
      reproducedMinor: reproduced.toFixed(),
      toleranceMinor: tolerance.toString(),
    });
  }
}
