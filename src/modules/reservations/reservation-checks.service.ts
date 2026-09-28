import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../database/transaction/unit-of-work';

export interface ReservedBalanceMismatch {
  readonly accountId: string;
  readonly code: string;
  readonly reservedMinor: bigint;
  readonly activeReservationsMinor: bigint;
}

export interface OverdueReservation {
  readonly reservationId: string;
  readonly accountId: string;
  readonly flowId: string;
  readonly amountMinor: bigint;
  readonly expiresAt: Date;
}

export interface ReservationIntegrityReport {
  readonly reservedBalanceMismatches: readonly ReservedBalanceMismatch[];
  /**
   * ACTIVE past `expires_at`. A liveness signal, NOT part of `isClean`: it means the
   * sweeper has not run yet or a flow is stuck — money is locked, never wrong (design
   * §6.3). It feeds the "reservations expired without resolution" alert (§10).
   */
  readonly overdueReservations: readonly OverdueReservation[];
  /** True when every account's `reserved_minor` equals the sum of its ACTIVE reservations. */
  readonly isClean: boolean;
}

/**
 * Design §8.1 check 4, read-only: a Phase 9 reconciliation input and the reservation
 * tests' oracle, alongside `LedgerChecksService` (checks 1–3, 5, 6).
 */
@Injectable()
export class ReservationChecksService {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /** Every account where `reserved_minor ≠ Σ(ACTIVE reservations.amount_minor)`. */
  async findReservedBalanceMismatches(): Promise<ReservedBalanceMismatch[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT accounts.id AS account_id, accounts.code,
              accounts.reserved_minor::text AS reserved_minor,
              coalesce(active.total, 0)::text AS active_minor
         FROM accounts
         LEFT JOIN (
           SELECT account_id, sum(amount_minor) AS total
             FROM reservations WHERE status = 'ACTIVE' GROUP BY account_id
         ) active ON active.account_id = accounts.id
        WHERE accounts.reserved_minor <> coalesce(active.total, 0)
        ORDER BY accounts.code`,
    )) as { account_id: string; code: string; reserved_minor: string; active_minor: string }[];
    return rows.map((row) => ({
      accountId: row.account_id,
      code: row.code,
      reservedMinor: BigInt(row.reserved_minor),
      activeReservationsMinor: BigInt(row.active_minor),
    }));
  }

  /** ACTIVE reservations whose `expires_at` is at or before `now` (the database clock by default). */
  async findOverdueReservations(now?: Date): Promise<OverdueReservation[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT id, account_id, flow_id, amount_minor::text AS amount_minor, expires_at
         FROM reservations
        WHERE status = 'ACTIVE' AND expires_at <= coalesce($1::timestamptz, now())
        ORDER BY expires_at, reservations.id`,
      [now ?? null],
    )) as { id: string; account_id: string; flow_id: string; amount_minor: string; expires_at: Date }[];
    return rows.map((row) => ({
      reservationId: row.id,
      accountId: row.account_id,
      flowId: row.flow_id,
      amountMinor: BigInt(row.amount_minor),
      expiresAt: row.expires_at,
    }));
  }

  async runAllChecks(now?: Date): Promise<ReservationIntegrityReport> {
    const reservedBalanceMismatches = await this.findReservedBalanceMismatches();
    const overdueReservations = await this.findOverdueReservations(now);
    return { reservedBalanceMismatches, overdueReservations, isClean: reservedBalanceMismatches.length === 0 };
  }
}
