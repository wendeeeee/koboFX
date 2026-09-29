import { InvariantViolationError } from '../../common/errors';
import { Dec, Money, MoneyDecimal, isInt64, majorToExactMinor, minorToMajorDecimal } from '../../common/money';
import { PricedCurrency, displayRate } from '../fx/pricing';
import { EntryDirection, LedgerEntryDraft } from '../ledger/ledger.types';

/** The four amounts a conversion posts, in minor units (design §5.6). */
export interface ConversionAmounts {
  /** Debited from the user, in the source currency. */
  readonly sourceAmountMinor: bigint;
  /** Credited to the user, in the target currency. */
  readonly targetAmountMinor: bigint;
  /** The source's value at the mid, in the target currency: what `FX_POSITION` gives up. */
  readonly targetMidValueMinor: bigint;
  /** Mid value − credit: the spread, and both roundings' residual. */
  readonly revenueMinor: bigint;
}

export interface ConversionLegs {
  readonly source: PricedCurrency;
  readonly target: PricedCurrency;
  readonly sourceAccountId: string;
  readonly targetAccountId: string;
  readonly amounts: ConversionAmounts;
}

/**
 * What must hold of every conversion before it is posted, whatever priced it: amounts in
 * BIGINT range, a positive debit and credit, a non-negative revenue, and the target legs
 * balancing exactly (credit + revenue = mid value). Only our own bug can break one, so a
 * breach is `INVARIANT_VIOLATION` (500, nothing posted), never a client error.
 */
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

/**
 * The §5.6 posting, in every direction (NGN→USD, USD→NGN, EUR→GBP alike — the revenue is
 * always in the target currency):
 *
 * | # | Account | Dr/Cr | Amount |
 * |---|---|---|---|
 * | 1 | `USER:{wallet}:{S}` | DEBIT | source |
 * | 2 | `FX_POSITION:{S}` | CREDIT | source |
 * | 3 | `FX_POSITION:{T}` | DEBIT | mid value |
 * | 4 | `USER:{wallet}:{T}` | CREDIT | credit |
 * | 5 | `REVENUE:FX_SPREAD:{T}` | CREDIT | revenue |
 *
 * Internal legs name the template (`systemAccount`), so the ledger picks the bucket from
 * the transaction id. A zero revenue posts FOUR entries: a zero-amount entry would record
 * a fact that did not happen (and `amount_minor > 0` is a CHECK). `EQUITY:ROUNDING` is
 * never used: both roundings land inside revenue by construction.
 */
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

/** The effective rate the user got, target per 1 source, exact: `(target / 10^mT) / (source / 10^mS)`. */
export function effectiveRateOf(source: PricedCurrency, sourceAmountMinor: bigint, target: PricedCurrency, targetAmountMinor: bigint): Dec {
  return minorToMajorDecimal(targetAmountMinor, target.minorUnit).div(minorToMajorDecimal(sourceAmountMinor, source.minorUnit));
}

/**
 * `rate_display` (design §4.3: display only): DERIVED from the posted amounts — which are
 * authoritative — at 12 significant digits, `ROUND_HALF_EVEN`. The same string the
 * response shows and `transactions.rate_display` stores.
 */
export function rateDisplayOf(source: PricedCurrency, sourceAmountMinor: bigint, target: PricedCurrency, targetAmountMinor: bigint): string {
  return displayRate(effectiveRateOf(source, sourceAmountMinor, target, targetAmountMinor));
}

/**
 * How far, in target minor units, re-applying a 12-significant-digit display rate to the
 * source may land from the credited amount. The display rate's relative error is at most
 * 5·10⁻¹², so the gap is at most `target × 5·10⁻¹²`; allow `max(1, ⌈target × 10⁻¹¹⌉)`. A
 * flat one-unit tolerance would fail honestly on very large amounts.
 */
export function rateDisplayToleranceMinor(targetAmountMinor: bigint): bigint {
  const scaled = new MoneyDecimal(targetAmountMinor.toString()).times('1e-11').ceil();
  const tolerance = BigInt(scaled.toFixed());
  return tolerance > 1n ? tolerance : 1n;
}

/**
 * Asserted at write time, before `post()`: the stored display rate, re-applied to the
 * debited source, reproduces the credited amount within `rateDisplayToleranceMinor`. A
 * breach means the display and the amounts disagree — our bug — so it is
 * `INVARIANT_VIOLATION` and nothing is posted.
 */
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
