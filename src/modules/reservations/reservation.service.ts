import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { InvariantViolationError } from '../../common/errors';
import { Money } from '../../common/money';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { LockedAccount, lockBalanceAuthorizingAccounts } from '../ledger/account-locks';
import { AccountNotFoundError } from '../ledger/ledger.errors';
import { LedgerService } from '../ledger/ledger.service';
import { PostingAuthorization } from '../ledger/ledger.types';
import { assertReductionAuthorized } from '../ledger/posting/authorization';
import { ReservationMetrics } from './reservation-metrics';
import {
  InvalidReservationError,
  ReservationConflictError,
  ReservationNotActiveError,
  ReservationNotFoundError,
} from './reservation.errors';
import { ExpiryResult, Reservation, ReservationStatus, ReserveRequest, SettlementPosting } from './reservation.types';
import { netUserAccountChanges, settledAmountMinor, settlementArithmetic } from './settlement';
import { ReservationCommand, decideTransition } from './transitions';

interface ReservationRow {
  id: string;
  account_id: string;
  flow_id: string;
  amount_minor: string;
  settled_minor: string | null;
  settlement_transaction_id: string | null;
  status: ReservationStatus;
  expires_at: Date;
  created_at: Date;
  resolved_at: Date | null;
  currency_code: string;
}

/** A reservation's columns, plus its currency (always its account's). `source` is the reservations row alias. */
const columns = (source: string) => `
  ${source}.id, ${source}.account_id, ${source}.flow_id,
  ${source}.amount_minor::text AS amount_minor, ${source}.settled_minor::text AS settled_minor,
  ${source}.settlement_transaction_id, ${source}.status, ${source}.expires_at, ${source}.created_at,
  ${source}.resolved_at, accounts.currency_code`;

/**
 * Funds reservation — hold, settle, release, expire (design §6.3).
 *
 * Every operation runs in ONE transaction (the ambient UnitOfWork, or its own) and
 * takes its locks in the global order:
 *   user accounts `FOR UPDATE ORDER BY id` → the reservation row `FOR UPDATE`
 *   → (inside `post()`) internal accounts.
 * `reserved_minor` is written ONLY here, always under the account's row lock and in
 * the same transaction as the reservation row change, so `reserved = Σ ACTIVE` holds
 * at every commit. Balances are never touched here; settlement moves money through
 * `LedgerService.post()`, the one write path.
 *
 * Transitions are decided from the state read under lock (`transitions.ts`), so every
 * operation is idempotent even out of order (design §6.5).
 */
@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ledger: LedgerService,
    private readonly metrics: ReservationMetrics,
  ) {}

  /**
   * Hold `amount` of the account's AVAILABLE balance for `flowId`. Linearizable: the
   * check and the hold happen under the account's row lock, the same lock a posting
   * takes (design §6.3 property 1).
   *
   * Idempotent: a reservation for the same (flow, account) is returned as it is, in
   * whatever state — never a second hold (handbook: "keep putting the funds on hold
   * idempotent even if they were already released"). The original `expiresAt` stands.
   * The same (flow, account) with a different amount is `RESERVATION_CONFLICT`.
   *
   * Refused holds raise `INSUFFICIENT_FUNDS` or `FUNDS_RESERVED` and write nothing.
   */
  async reserve(request: ReserveRequest): Promise<Reservation> {
    if (!request.amount.isPositive()) {
      throw new InvalidReservationError('A reservation amount must be positive.', {
        amountMinor: request.amount.toMinorString(),
      });
    }
    const accountId = request.accountId.toLowerCase();
    const flowId = request.flowId.toLowerCase();

    return this.unitOfWork.run(async (manager) => {
      const account = await this.lockReservableAccount(manager, accountId);
      if (account.currencyCode !== request.amount.currency) {
        throw new InvalidReservationError('A reservation must be in its account’s currency.', {
          accountId,
          accountCurrency: account.currencyCode,
          reservationCurrency: request.amount.currency,
        });
      }

      const existing = await this.findByFlowAndAccount(manager, flowId, accountId);
      if (existing) {
        if (existing.amount.equals(request.amount)) return existing;
        throw new ReservationConflictError('This flow already holds a different amount on this account.', {
          reservationId: existing.id,
          flowId,
          accountId,
          heldMinor: existing.amount.toMinorString(),
          requestedMinor: request.amount.toMinorString(),
        });
      }

      const [clock] = (await manager.query(`SELECT $1::timestamptz > now() AS in_future`, [request.expiresAt])) as {
        in_future: boolean;
      }[];
      if (!clock.in_future) {
        throw new InvalidReservationError('A reservation must expire in the future.', {
          expiresAt: request.expiresAt.toISOString(),
        });
      }

      assertReductionAuthorized(accountId, account, request.amount.amountMinor);

      const [inserted] = (await manager.query(
        `WITH inserted AS (
           INSERT INTO reservations (account_id, flow_id, amount_minor, expires_at)
           VALUES ($1, $2, $3, $4)
           RETURNING *
         )
         SELECT ${columns('inserted')} FROM inserted JOIN accounts ON accounts.id = inserted.account_id`,
        [accountId, flowId, request.amount.toMinorString(), request.expiresAt],
      )) as ReservationRow[];
      await this.adjustReserved(manager, accountId, request.amount.amountMinor);
      return toReservation(inserted);
    });
  }

  /**
   * Post the ACTUAL amount through `LedgerService.post()`, record it, and give back
   * the whole hold — in one transaction. The actual is the posting's net reduction of
   * the reserved account: less than the estimate releases the remainder; more is booked
   * as an overdraft, never refused (design §16, "Settlement exceeds reservation").
   *
   * The posting is `SYSTEM_DRIVEN`: the spend was authorized when it was reserved.
   * Because that skips the gate, the posting may not reduce any other user account.
   *
   * By state, under lock:
   * - ACTIVE → SETTLED: release the hold, post.
   * - EXPIRED → SETTLED: a late settlement. The hold is already gone; post. Logged.
   * - SETTLED: a retry. Same actual ⇒ the original settlement, nothing posted;
   *   a different actual ⇒ `RESERVATION_CONFLICT`.
   * - RELEASED: `RESERVATION_NOT_ACTIVE`. If money moved anyway, that is a
   *   compensating system-driven posting, not a settlement.
   *
   * Lock order: every user account the posting touches, plus the reserved one, in ONE
   * batch; then the reservation row. When this joins a unit that already locked some
   * of them (e.g. reserve → settle in one transaction), lock the full set up front with
   * `LedgerService.lockUserAccounts`.
   */
  async settle(reservationId: string, posting: SettlementPosting): Promise<Reservation> {
    const transaction = posting.transaction as SettlementPosting['transaction'] & {
      authorization?: unknown;
      correctsTransactionId?: unknown;
    };
    if (transaction.correctsTransactionId !== undefined || transaction.authorization !== undefined) {
      throw new InvalidReservationError(
        'A settlement posting decides its own authorization and is never a correction.',
        { reservationId },
      );
    }

    return this.unitOfWork.run(async (manager) => {
      const accountId = await this.findAccountId(manager, reservationId);
      const postingAccountIds = posting.entries.flatMap((entry) =>
        'accountId' in entry.account ? [entry.account.accountId.toLowerCase()] : [],
      );
      const lockedAccounts = await lockBalanceAuthorizingAccounts(manager, [accountId, ...postingAccountIds]);
      const reservation = await this.lockReservation(manager, reservationId);

      const actualMinor = settledAmountMinor(accountId, netUserAccountChanges(posting.entries, lockedAccounts));
      const actual = Money.of(actualMinor, reservation.amount.currency);

      const decision = decideTransition(reservation.status, ReservationCommand.SETTLE);
      if (decision.kind === 'REPLAY') {
        if ((reservation.settledAmount as Money).equals(actual)) return reservation;
        throw new ReservationConflictError('This reservation was already settled for a different amount.', {
          reservationId,
          settledMinor: (reservation.settledAmount as Money).toMinorString(),
          requestedMinor: actual.toMinorString(),
          settlementTransactionId: reservation.settlementTransactionId,
        });
      }
      if (decision.kind !== 'APPLY') {
        throw new ReservationNotActiveError('This reservation was released; it can no longer be settled.', {
          reservationId,
          status: reservation.status,
        });
      }

      if (decision.releasesHold) {
        await this.adjustReserved(manager, accountId, -reservation.amount.amountMinor);
      }
      const posted = await this.ledger.post({
        transaction: { ...posting.transaction, authorization: PostingAuthorization.SYSTEM_DRIVEN },
        entries: posting.entries,
      });
      const [settled] = (await manager.query(
        `WITH updated AS (
           UPDATE reservations
              SET status = 'SETTLED', settled_minor = $2, settlement_transaction_id = $3,
                  resolved_at = coalesce(resolved_at, now())
            WHERE id = $1
           RETURNING *
         )
         SELECT ${columns('updated')} FROM updated JOIN accounts ON accounts.id = updated.account_id`,
        [reservationId, actualMinor.toString(), posted.transactionId],
      )) as ReservationRow[];

      const { excessOverEstimateMinor } = settlementArithmetic(reservation.amount.amountMinor, actualMinor);
      if (excessOverEstimateMinor > 0n || reservation.status === ReservationStatus.EXPIRED) {
        this.logger.warn({
          message: 'Reservation settled beyond its hold; any resulting overdraft is booked (design §16).',
          reservationId,
          accountId,
          lateSettlement: reservation.status === ReservationStatus.EXPIRED,
          estimateMinor: reservation.amount.toMinorString(),
          actualMinor: actualMinor.toString(),
          excessOverEstimateMinor: excessOverEstimateMinor.toString(),
          settlementTransactionId: posted.transactionId,
        });
      }
      return toReservation(settled);
    });
  }

  /**
   * Give the whole hold back to available. ACTIVE → RELEASED; in any other state the
   * goal — no hold remains — already holds, so it succeeds as a no-op and returns the
   * reservation unchanged (design §6.5, out-of-order retries).
   */
  async release(reservationId: string): Promise<Reservation> {
    return this.unitOfWork.run(async (manager) => {
      const accountId = await this.findAccountId(manager, reservationId);
      await lockBalanceAuthorizingAccounts(manager, [accountId]);
      const reservation = await this.lockReservation(manager, reservationId);
      const decision = decideTransition(reservation.status, ReservationCommand.RELEASE);
      if (decision.kind !== 'APPLY') return reservation;

      await this.adjustReserved(manager, accountId, -reservation.amount.amountMinor);
      const [released] = (await manager.query(
        `WITH updated AS (
           UPDATE reservations SET status = 'RELEASED', resolved_at = now() WHERE id = $1 RETURNING *
         )
         SELECT ${columns('updated')} FROM updated JOIN accounts ON accounts.id = updated.account_id`,
        [reservationId],
      )) as ReservationRow[];
      return toReservation(released);
    });
  }

  /**
   * The safety net beneath each flow's own resolution (design §6.3 property 3): expire
   * up to `batchSize` ACTIVE reservations whose `expires_at <= now`, giving their holds
   * back. `now` is a parameter so the clock is controllable.
   *
   * It never blocks and never double-processes: accounts and reservations are taken
   * `FOR UPDATE SKIP LOCKED`. An account busy with a settle, release or another
   * sweeper is simply left for the next run, and every row is re-checked under lock.
   * Locks still follow the global order (accounts, then reservations).
   */
  async expireDue(now: Date, batchSize: number): Promise<ExpiryResult> {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new InvalidReservationError('batchSize must be a positive integer.', { batchSize });
    }
    const expired = await this.unitOfWork.run(async (manager) => {
      const candidates = (await manager.query(
        `SELECT id, account_id FROM reservations
          WHERE status = 'ACTIVE' AND expires_at <= $1
          ORDER BY expires_at, reservations.id
          LIMIT $2`,
        [now, batchSize],
      )) as { id: string; account_id: string }[];
      if (candidates.length === 0) return [];

      const lockedAccounts = await lockBalanceAuthorizingAccounts(
        manager,
        candidates.map((candidate) => candidate.account_id),
        { skipLocked: true },
      );
      const lockable = candidates.filter((candidate) => lockedAccounts.has(candidate.account_id));
      if (lockable.length === 0) return [];

      const rows = (await manager.query(
        `WITH due AS (
           SELECT id FROM reservations
            WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE' AND expires_at <= $2
            ORDER BY reservations.id
              FOR UPDATE SKIP LOCKED
         ),
         updated AS (
           UPDATE reservations SET status = 'EXPIRED', resolved_at = now()
             FROM due WHERE reservations.id = due.id
           RETURNING reservations.*
         )
         SELECT ${columns('updated')} FROM updated JOIN accounts ON accounts.id = updated.account_id
          ORDER BY updated.id`,
        [lockable.map((candidate) => candidate.id), now],
      )) as ReservationRow[];

      const releasedByAccount = new Map<string, bigint>();
      for (const row of rows) {
        releasedByAccount.set(row.account_id, (releasedByAccount.get(row.account_id) ?? 0n) + BigInt(row.amount_minor));
      }
      for (const accountId of [...releasedByAccount.keys()].sort()) {
        await this.adjustReserved(manager, accountId, -(releasedByAccount.get(accountId) as bigint));
      }
      return rows.map(toReservation);
    });

    this.metrics.recordExpired(expired.length);
    if (expired.length > 0) {
      this.logger.warn({
        message: 'Reservations expired unresolved; the owning flows failed to settle or release them (design §16).',
        reservationIds: expired.map((reservation) => reservation.id),
      });
    }
    return { expired };
  }

  async findById(reservationId: string): Promise<Reservation | null> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT ${columns('reservations')} FROM reservations JOIN accounts ON accounts.id = reservations.account_id
        WHERE reservations.id = $1`,
      [reservationId],
    )) as ReservationRow[];
    return row ? toReservation(row) : null;
  }

  private async lockReservableAccount(manager: EntityManager, accountId: string): Promise<LockedAccount> {
    const locked = await lockBalanceAuthorizingAccounts(manager, [accountId]);
    const account = locked.get(accountId);
    if (account) return account;
    const [exists] = (await manager.query(`SELECT id FROM accounts WHERE id = $1`, [accountId])) as { id: string }[];
    if (!exists) {
      throw new AccountNotFoundError('The account to reserve against does not exist.', { accountId });
    }
    throw new InvalidReservationError('Only balance-authorizing (user) accounts can be reserved against.', {
      accountId,
    });
  }

  private async findByFlowAndAccount(
    manager: EntityManager,
    flowId: string,
    accountId: string,
  ): Promise<Reservation | null> {
    const [row] = (await manager.query(
      `SELECT ${columns('reservations')} FROM reservations JOIN accounts ON accounts.id = reservations.account_id
        WHERE reservations.flow_id = $1 AND reservations.account_id = $2`,
      [flowId, accountId],
    )) as ReservationRow[];
    return row ? toReservation(row) : null;
  }

  /** The reservation's account, read WITHOUT a lock — `account_id` is immutable, so it cannot go stale. */
  private async findAccountId(manager: EntityManager, reservationId: string): Promise<string> {
    const [row] = (await manager.query(`SELECT account_id FROM reservations WHERE id = $1`, [reservationId])) as {
      account_id: string;
    }[];
    if (!row) throw new ReservationNotFoundError('Reservation not found.', { reservationId });
    return row.account_id;
  }

  /** Level 3 of the lock order. Callers hold the reservation's account lock already. */
  private async lockReservation(manager: EntityManager, reservationId: string): Promise<Reservation> {
    const [row] = (await manager.query(
      `SELECT ${columns('reservations')} FROM reservations JOIN accounts ON accounts.id = reservations.account_id
        WHERE reservations.id = $1
          FOR UPDATE OF reservations`,
      [reservationId],
    )) as ReservationRow[];
    if (!row) throw new ReservationNotFoundError('Reservation not found.', { reservationId });
    return toReservation(row);
  }

  /** The only write to `reserved_minor`. The caller holds the account's row lock. */
  private async adjustReserved(manager: EntityManager, accountId: string, deltaMinor: bigint): Promise<void> {
    const rows = (await manager.query(
      `WITH updated AS (
         UPDATE accounts SET reserved_minor = reserved_minor + $2 WHERE id = $1 RETURNING id
       )
       SELECT id FROM updated`,
      [accountId, deltaMinor.toString()],
    )) as { id: string }[];
    if (rows.length !== 1) {
      throw new InvariantViolationError('The reserved account vanished while locked.', { accountId });
    }
  }
}

function toReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    accountId: row.account_id,
    flowId: row.flow_id,
    amount: Money.fromMinorString(row.amount_minor, row.currency_code),
    status: row.status,
    settledAmount: row.settled_minor === null ? null : Money.fromMinorString(row.settled_minor, row.currency_code),
    settlementTransactionId: row.settlement_transaction_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}
