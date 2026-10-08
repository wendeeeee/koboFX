import { AccountType, EntryDirection, NormalSide } from '../ledger.types';

/**
 * Data-driven sign logic. an entry on its account's normal side
 * increases the balance; on the opposite side it decreases it. 
 */
export function signedBalanceChange(
  normalSide: NormalSide,
  direction: EntryDirection,
  amountMinor: bigint,
): bigint {
  return (direction as string) === (normalSide as string) ? amountMinor : -amountMinor;
}

const STANDARD_NORMAL_SIDE: Readonly<Record<AccountType, NormalSide>> = {
  [AccountType.ASSET]: NormalSide.DEBIT,
  [AccountType.EXPENSE]: NormalSide.DEBIT,
  [AccountType.LIABILITY]: NormalSide.CREDIT,
  [AccountType.EQUITY]: NormalSide.CREDIT,
  [AccountType.REVENUE]: NormalSide.CREDIT,
};

/** The side on which an account of this type normally increases. */
export function standardNormalSide(accountType: AccountType): NormalSide {
  return STANDARD_NORMAL_SIDE[accountType];
}

/**
 * An account's balance as it counts towards its type's total in the accounting
 * equation. For an ordinary account this is its balance; for a contra account (normal
 * side opposite to its type's) it counts negatively.
 */
export function balanceTowardsTypeTotal(
  accountType: AccountType,
  normalSide: NormalSide,
  balanceMinor: bigint,
): bigint {
  return standardNormalSide(accountType) === normalSide ? balanceMinor : -balanceMinor;
}

export function oppositeDirection(direction: EntryDirection): EntryDirection {
  return direction === EntryDirection.DEBIT ? EntryDirection.CREDIT : EntryDirection.DEBIT;
}
