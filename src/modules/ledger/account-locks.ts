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

/** Internal-account locks taken through `lockInternalAccounts`, per transaction (see there). */
const heldInternalLocks = new WeakMap<EntityManager, Set<string>>();

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
  const internalHeld = heldInternalLocks.get(manager);
  if (internalHeld !== undefined && internalHeld.size > 0 && newlyLocked.length > 0) {
    throw new InvariantViolationError(
      'A user account was locked after internal accounts in one transaction; user accounts come first.',
      { internalHeld: [...internalHeld].sort(), newlyLocked },
    );
  }
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

/**
 * Lock internal (non-balance-authorizing) accounts `FOR UPDATE ORDER BY id`, for a unit that makes several postings
 * over the same internal accounts (WITHDRAWAL_PLAN.md §G.3: a withdrawal's provider debit + principal settlement, or
 * principal reversal + provider return). `post()` locks internal rows per posting by blind UPDATE; chaining postings
 * whose internal sets interleave could acquire them out of order. Lock the exact union here FIRST — after the user
 * accounts and reservation rows (the global order) — and every later posting re-touches held rows for free.
 *
 * Guards, per transaction: internal ids are acquired ascending across calls, and no user account may be newly locked
 * once internal locks are held. Either violation is an `INVARIANT_VIOLATION`, never a silent deadlock risk.
 */
export async function lockInternalAccounts(manager: EntityManager, accountIds: readonly string[]): Promise<void> {
  const ids = [...new Set(accountIds.map((id) => id.toLowerCase()))].sort();
  if (ids.length === 0) return;

  const held = heldInternalLocks.get(manager) ?? new Set<string>();
  const highestHeld = [...held].sort().at(-1);
  const newlyRequested = ids.filter((id) => !held.has(id));
  if (highestHeld !== undefined && newlyRequested.some((id) => id < highestHeld)) {
    throw new InvariantViolationError(
      'Internal accounts were locked out of id order in one transaction; lock the full set up front.',
      { alreadyHeld: [...held].sort(), newlyRequested },
    );
  }

  const rows = (await manager.query(
    `SELECT id FROM accounts
      WHERE id = ANY($1::uuid[]) AND NOT authorizes_balance
      ORDER BY accounts.id
        FOR UPDATE`,
    [ids],
  )) as { id: string }[];
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((row) => row.id));
    throw new InvariantViolationError('Only existing internal accounts can be locked as internal accounts.', {
      missingOrBalanceAuthorizing: ids.filter((id) => !found.has(id)),
    });
  }
  for (const id of ids) held.add(id);
  heldInternalLocks.set(manager, held);
}
