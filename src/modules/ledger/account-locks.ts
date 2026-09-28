import { EntityManager } from 'typeorm';
import { InvariantViolationError } from '../../common/errors';
import { NormalSide } from './ledger.types';
import { AccountFunds } from './posting/authorization';

/** A balance-authorizing (user) account, row-locked `FOR UPDATE` by this transaction. */
export interface LockedAccount extends AccountFunds {
  readonly id: string;
  readonly currencyCode: string;
  readonly normalSide: NormalSide;
}

export interface LockOptions {
  /**
   * `FOR UPDATE SKIP LOCKED`: accounts another transaction holds are left out of the
   * result instead of waited for. For the expiry sweeper, which must never block.
   */
  readonly skipLocked?: boolean;
}

/**
 * The user-account locks each open transaction holds, so the lock-order guard can see
 * them. Keyed by the transaction's EntityManager: one per transaction, and gone with it.
 */
const heldLocks = new WeakMap<EntityManager, Set<string>>();

/**
 * Lock balance-authorizing accounts `FOR UPDATE ORDER BY id` — level 2 of the global
 * lock order (CLAUDE.md): original transaction → user accounts → reservations →
 * internal accounts. Ids of internal accounts are ignored; they are never row-locked.
 *
 * **The guard.** Lock waits cannot form a cycle as long as every transaction takes its
 * user-account locks in ascending id order. Re-locking a row already held is free, but
 * a transaction that newly locks an account whose id sorts BELOW one it already holds
 * breaks that order (e.g. reserve the NGN account, then settle a posting that also
 * credits a lower-id USD account). That raises `INVARIANT_VIOLATION` every time,
 * contended or not, so the bug shows up in any test instead of as a rare production
 * deadlock. A caller that will touch several user accounts across several calls in one
 * transaction locks the whole set first (`LedgerService.lockUserAccounts`).
 *
 * `manager` must be a transaction's manager: a row lock outside a transaction is
 * released as soon as the statement ends.
 */
export async function lockBalanceAuthorizingAccounts(
  manager: EntityManager,
  accountIds: readonly string[],
  options: LockOptions = {},
): Promise<Map<string, LockedAccount>> {
  const ids = [...new Set(accountIds.map((id) => id.toLowerCase()))].sort();
  const locked = new Map<string, LockedAccount>();
  if (ids.length === 0) return locked;

  const rows = (await manager.query(
    `SELECT id,
            currency_code,
            normal_side,
            balance_minor::text         AS balance_minor,
            reserved_minor::text        AS reserved_minor,
            overdraft_limit_minor::text AS overdraft_limit_minor
       FROM accounts
      WHERE id = ANY($1::uuid[]) AND authorizes_balance
      ORDER BY accounts.id
        FOR UPDATE${options.skipLocked ? ' SKIP LOCKED' : ''}`,
    [ids],
  )) as {
    id: string;
    currency_code: string;
    normal_side: NormalSide;
    balance_minor: string;
    reserved_minor: string;
    overdraft_limit_minor: string;
  }[];

  const held = heldLocks.get(manager) ?? new Set<string>();
  const highestHeld = [...held].sort().at(-1);
  const newlyLocked = rows.map((row) => row.id).filter((id) => !held.has(id));
  if (highestHeld !== undefined && newlyLocked.some((id) => id < highestHeld)) {
    throw new InvariantViolationError(
      'User accounts were locked out of id order in one transaction; lock the full set up front.',
      { alreadyHeld: [...held].sort(), newlyLocked },
    );
  }
  for (const id of newlyLocked) held.add(id);
  heldLocks.set(manager, held);

  for (const row of rows) {
    locked.set(row.id, {
      id: row.id,
      currencyCode: row.currency_code,
      normalSide: row.normal_side,
      balanceMinor: BigInt(row.balance_minor),
      reservedMinor: BigInt(row.reserved_minor),
      overdraftLimitMinor: BigInt(row.overdraft_limit_minor),
    });
  }
  return locked;
}
