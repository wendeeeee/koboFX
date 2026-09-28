import { LedgerEntryDraft, NormalSide } from '../ledger/ledger.types';
import { signedBalanceChange } from '../ledger/posting/sign';
import { InvalidReservationError } from './reservation.errors';

/**
 * Each user account's NET balance change in a settlement posting, judged the same way
 * the posting engine judges it (design §6.2). `userAccounts` maps each locked
 * balance-authorizing account to its normal side; entries on other accounts (internal
 * ones, by template or by id) are not user money and are ignored.
 */
export function netUserAccountChanges(
  entries: readonly LedgerEntryDraft[],
  userAccounts: ReadonlyMap<string, { readonly normalSide: NormalSide }>,
): Map<string, bigint> {
  const changes = new Map<string, bigint>();
  for (const entry of entries) {
    if (!('accountId' in entry.account)) continue;
    const accountId = entry.account.accountId.toLowerCase();
    const account = userAccounts.get(accountId);
    if (!account) continue;
    const change = signedBalanceChange(account.normalSide, entry.direction, entry.amount.amountMinor);
    changes.set(accountId, (changes.get(accountId) ?? 0n) + change);
  }
  return changes;
}

/**
 * The actual amount a settlement posting spends from the reserved account: its net
 * reduction there. Settlement is posted `SYSTEM_DRIVEN` (the spend was authorized at
 * reserve time), so the shape is checked here instead of by the gate:
 *
 * - it must reduce the reserved account by more than zero — a zero actual is a
 *   release, not a settlement;
 * - it must not reduce any OTHER user account: that spend was never reserved, and
 *   skipping the gate for it would let unauthorized money move.
 */
export function settledAmountMinor(reservationAccountId: string, changes: ReadonlyMap<string, bigint>): bigint {
  const reduction = -(changes.get(reservationAccountId) ?? 0n);
  if (reduction <= 0n) {
    throw new InvalidReservationError(
      'A settlement posting must reduce the reserved account; to spend nothing, release the reservation.',
      { accountId: reservationAccountId, netChangeMinor: (-reduction).toString() },
    );
  }
  for (const [accountId, change] of changes) {
    if (accountId !== reservationAccountId && change < 0n) {
      throw new InvalidReservationError('A settlement posting may not reduce a user account that was not reserved.', {
        reservedAccountId: reservationAccountId,
        accountId,
        netChangeMinor: change.toString(),
      });
    }
  }
  return reduction;
}

export interface SettlementArithmetic {
  /** Hold released beyond what was spent: estimate − actual when the actual is smaller. */
  readonly releasedRemainderMinor: bigint;
  /** Spent beyond the hold: actual − estimate when larger. Booked, never refused (design §16). */
  readonly excessOverEstimateMinor: bigint;
}

/** We reserve an estimate, settle the actual, and release the remainder (design §6.3 property 2). */
export function settlementArithmetic(estimateMinor: bigint, actualMinor: bigint): SettlementArithmetic {
  return {
    releasedRemainderMinor: estimateMinor > actualMinor ? estimateMinor - actualMinor : 0n,
    excessOverEstimateMinor: actualMinor > estimateMinor ? actualMinor - estimateMinor : 0n,
  };
}
