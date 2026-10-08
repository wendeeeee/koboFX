import { LedgerEntryDraft, NormalSide } from '../ledger/ledger.types';
import { signedBalanceChange } from '../ledger/posting/sign';
import { InvalidReservationError } from './reservation.errors';


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
  readonly releasedRemainderMinor: bigint;
  readonly excessOverEstimateMinor: bigint;
}


export function settlementArithmetic(estimateMinor: bigint, actualMinor: bigint): SettlementArithmetic {
  return {
    releasedRemainderMinor: estimateMinor > actualMinor ? estimateMinor - actualMinor : 0n,
    excessOverEstimateMinor: actualMinor > estimateMinor ? actualMinor - estimateMinor : 0n,
  };
}
