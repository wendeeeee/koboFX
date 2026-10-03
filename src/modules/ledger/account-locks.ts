import { EntityManager } from 'typeorm';
import { InvariantViolationError } from '../../common/errors';
import { NormalSide } from './ledger.types';
import { AccountFunds } from './posting/authorization';

export interface LockedAccount extends AccountFunds {
  readonly id: string;
  readonly currencyCode: string;
  readonly normalSide: NormalSide;
}

export interface LockOptions {
  /**
   * accounts another transaction holds are left out of the
   * result instead of waited for.
   */
  readonly skipLocked?: boolean;
}

/**
 * The user-account locks each open transaction holds, so the lock-order guard can see
 * them. Keyed by the transaction's EntityManager, one per transaction.
 */
const heldLocks = new WeakMap<EntityManager, Set<string>>();

/**
 * Lock balance-authorizing accounts `FOR UPDATE ORDER BY id`: 
 * original transaction → user accounts → reservations → internal accounts 
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
