import { Injectable } from '@nestjs/common';
import { InvariantViolationError } from '../../../common/errors';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { microsecondsToTimestamp, timestampToMicroseconds } from '../../transactions/history-time';
import { AdminPosition } from '../reads/admin-cursor';
import { UserRole, UserStatus } from '../../users/user.types';
import { Approval, ApprovalActionType, ApprovalStatus } from './approval.types';

interface ApprovalRow {
  id: string;
  action_type: ApprovalActionType;
  payload: Record<string, unknown>;
  payload_hash: string;
  reason: string;
  status: ApprovalStatus;
  is_break_glass: boolean;
  break_id: string | null;
  requested_by: string;
  requested_at: Date;
  expires_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  rejected_by: string | null;
  rejected_at: Date | null;
  rejection_reason: string | null;
  cancelled_at: Date | null;
  expired_at: Date | null;
  executed_by: string | null;
  executed_at: Date | null;
  execution_failure_code: string | null;
  result_reference: string | null;
  break_glass_reviewed_by: string | null;
  break_glass_reviewed_at: Date | null;
  break_glass_review_note: string | null;
}

const COLUMNS = `approvals.id, approvals.action_type, approvals.payload, approvals.payload_hash, approvals.reason,
  approvals.status, approvals.is_break_glass, approvals.break_id, approvals.requested_by, approvals.requested_at,
  approvals.expires_at, approvals.approved_by, approvals.approved_at, approvals.rejected_by, approvals.rejected_at,
  approvals.rejection_reason, approvals.cancelled_at, approvals.expired_at, approvals.executed_by, approvals.executed_at,
  approvals.execution_failure_code, approvals.result_reference, approvals.break_glass_reviewed_by,
  approvals.break_glass_reviewed_at, approvals.break_glass_review_note`;

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    actionType: row.action_type,
    payload: row.payload,
    payloadHash: row.payload_hash,
    reason: row.reason,
    status: row.status,
    isBreakGlass: row.is_break_glass,
    breakId: row.break_id,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    rejectedBy: row.rejected_by,
    rejectedAt: row.rejected_at,
    rejectionReason: row.rejection_reason,
    cancelledAt: row.cancelled_at,
    expiredAt: row.expired_at,
    executedBy: row.executed_by,
    executedAt: row.executed_at,
    executionFailureCode: row.execution_failure_code,
    resultReference: row.result_reference,
    breakGlassReviewedBy: row.break_glass_reviewed_by,
    breakGlassReviewedAt: row.break_glass_reviewed_at,
    breakGlassReviewNote: row.break_glass_review_note,
  };
}

export interface NewApproval {
  readonly actionType: ApprovalActionType;
  readonly payload: object;
  readonly payloadHash: string;
  readonly reason: string;
  readonly isBreakGlass: boolean;
  readonly breakId: string | null;
  readonly requestedBy: string;
  readonly timeToLiveHours: number;
}

export interface ApprovalListFilter {
  readonly status: ApprovalStatus | null;
  readonly actionType: ApprovalActionType | null;
  /** Break-glass uses not yet reviewed (the security queue). */
  readonly unreviewedBreakGlass: boolean;
}


/** An actor as the approval's eligibility rules see them, read under a row lock. */
export interface ActorState {
  readonly id: string;
  readonly role: UserRole;
  readonly status: UserStatus;
}

/**
 * `approvals` access (raw SQL on the ambient UnitOfWork). Every write is one statement that also names the
 * state it expects (`AND status = …`), so a stale caller changes nothing and learns it (`null`).
 */
@Injectable()
export class ApprovalRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async insert(approval: NewApproval): Promise<Approval> {
    const [row] = (await this.unitOfWork.requireTransaction().query(
      `WITH inserted AS (
         INSERT INTO approvals (action_type, payload, payload_hash, reason, is_break_glass, break_id, requested_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(hours => $8))
         RETURNING *
       )
       SELECT ${COLUMNS.replaceAll('approvals.', 'inserted.')} FROM inserted`,
      [
        approval.actionType,
        JSON.stringify(approval.payload),
        approval.payloadHash,
        approval.reason,
        approval.isBreakGlass,
        approval.breakId,
        approval.requestedBy,
        approval.timeToLiveHours,
      ],
    )) as ApprovalRow[];
    return toApproval(row);
  }

  async find(approvalId: string): Promise<Approval | null> {
    const [row] = (await this.unitOfWork.manager.query(`SELECT ${COLUMNS} FROM approvals WHERE approvals.id = $1`, [approvalId])) as ApprovalRow[];
    return row ? toApproval(row) : null;
  }

  /** The approval row, locked until the transaction ends: every decision is taken under it. */
  async lock(approvalId: string): Promise<Approval | null> {
    const [row] = (await this.unitOfWork
      .requireTransaction()
      .query(`SELECT ${COLUMNS} FROM approvals WHERE approvals.id = $1 FOR UPDATE`, [approvalId])) as ApprovalRow[];
    return row ? toApproval(row) : null;
  }

  /** The people involved, `FOR SHARE` in id order: a role or status change waits for this decision (and vice versa). */
  async lockActors(userIds: readonly string[]): Promise<Map<string, ActorState>> {
    const rows = (await this.unitOfWork.requireTransaction().query(
      `SELECT id, role, status FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`,
      [[...new Set(userIds)]],
    )) as { id: string; role: UserRole; status: UserStatus }[];
    return new Map(rows.map((row) => [row.id, { id: row.id, role: row.role, status: row.status }]));
  }

  /** The database's clock: expiry is decided on the same clock that stamped `expires_at`. */
  async now(): Promise<Date> {
    const [row] = (await this.unitOfWork.manager.query(`SELECT now() AS now`)) as { now: Date }[];
    return row.now;
  }

  async markApproved(approvalId: string, approverId: string): Promise<Approval> {
    return this.transition(
      `UPDATE approvals SET status = 'APPROVED', approved_by = $2, approved_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'PENDING'`,
      [approvalId, approverId],
    );
  }

  async markExecuted(approvalId: string, executorId: string, resultReference: string, from: ApprovalStatus): Promise<Approval> {
    return this.transition(
      `UPDATE approvals SET status = 'EXECUTED', executed_by = $2, executed_at = now(), result_reference = $3, updated_at = now()
        WHERE id = $1 AND status = $4::approval_status`,
      [approvalId, executorId, resultReference, from],
    );
  }

  async markExecutionFailed(approvalId: string, executorId: string, failureCode: string, from: ApprovalStatus): Promise<Approval> {
    return this.transition(
      `UPDATE approvals SET status = 'EXECUTION_FAILED', executed_by = $2, executed_at = now(), execution_failure_code = $3,
              updated_at = now()
        WHERE id = $1 AND status = $4::approval_status`,
      [approvalId, executorId, failureCode, from],
    );
  }

  async markRejected(approvalId: string, rejecterId: string, reason: string): Promise<Approval> {
    return this.transition(
      `UPDATE approvals SET status = 'REJECTED', rejected_by = $2, rejected_at = now(), rejection_reason = $3, updated_at = now()
        WHERE id = $1 AND status = 'PENDING'`,
      [approvalId, rejecterId, reason],
    );
  }

  async markCancelled(approvalId: string, requesterId: string): Promise<Approval> {
    return this.transition(
      `UPDATE approvals SET status = 'CANCELLED', cancelled_by = $2, cancelled_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'PENDING' AND requested_by = $2`,
      [approvalId, requesterId],
    );
  }

  async markReviewed(approvalId: string, reviewerId: string, note: string): Promise<Approval> {
    return this.transition(
      `UPDATE approvals SET break_glass_reviewed_by = $2, break_glass_reviewed_at = now(), break_glass_review_note = $3,
              updated_at = now()
        WHERE id = $1 AND is_break_glass AND break_glass_reviewed_at IS NULL AND status IN ('EXECUTED', 'EXECUTION_FAILED')`,
      [approvalId, reviewerId, note],
    );
  }

  /** PENDING past `expires_at` → EXPIRED, oldest first; skips rows someone is deciding right now. */
  async expireDue(limit: number): Promise<Approval[]> {
    const rows = (await this.unitOfWork.requireTransaction().query(
      `WITH due AS (
         SELECT id FROM approvals WHERE status = 'PENDING' AND expires_at <= now()
          ORDER BY expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
       ), updated AS (
         UPDATE approvals SET status = 'EXPIRED', expired_at = now(), updated_at = now()
          WHERE id IN (SELECT id FROM due) RETURNING *
       )
       SELECT ${COLUMNS.replaceAll('approvals.', 'updated.')} FROM updated ORDER BY updated.expires_at, updated.id`,
      [limit],
    )) as ApprovalRow[];
    return rows.map(toApproval);
  }

  /** Break-glass uses unreviewed past the window and not yet alerted: marked alerted (once) and returned. */
  async claimOverdueBreakGlass(reviewHours: number, limit: number): Promise<Approval[]> {
    const rows = (await this.unitOfWork.requireTransaction().query(
      `WITH due AS (
         SELECT id FROM approvals
          WHERE is_break_glass AND break_glass_reviewed_at IS NULL AND break_glass_overdue_alerted_at IS NULL
            AND requested_at <= now() - make_interval(hours => $1)
          ORDER BY requested_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
       ), updated AS (
         UPDATE approvals SET break_glass_overdue_alerted_at = now(), updated_at = now()
          WHERE id IN (SELECT id FROM due) RETURNING *
       )
       SELECT ${COLUMNS.replaceAll('approvals.', 'updated.')} FROM updated ORDER BY updated.requested_at, updated.id`,
      [reviewHours, limit],
    )) as ApprovalRow[];
    return rows.map(toApproval);
  }

  /** `break_glass_unreviewed{overdue}`: counted from the database, right across processes. */
  async countUnreviewedBreakGlass(reviewHours: number): Promise<{ withinWindow: number; overdue: number }> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT count(*) FILTER (WHERE requested_at > now() - make_interval(hours => $1))::int AS within_window,
              count(*) FILTER (WHERE requested_at <= now() - make_interval(hours => $1))::int AS overdue
         FROM approvals WHERE is_break_glass AND break_glass_reviewed_at IS NULL`,
      [reviewHours],
    )) as { within_window: number; overdue: number }[];
    return { withinWindow: row.within_window, overdue: row.overdue };
  }

  /** Newest first, keyset on `(requested_at, id)` in exact microseconds. Fetches `limit` rows. */
  async list(filter: ApprovalListFilter, position: AdminPosition | null, limit: number): Promise<{ item: Approval; position: AdminPosition }[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT ${COLUMNS}, ${timestampToMicroseconds('approvals.requested_at')}::text AS sort_micros FROM approvals
        WHERE ($1::approval_status IS NULL OR approvals.status = $1::approval_status)
          AND ($2::approval_action_type IS NULL OR approvals.action_type = $2::approval_action_type)
          AND (NOT $3::boolean OR (approvals.is_break_glass AND approvals.break_glass_reviewed_at IS NULL))
          AND ($4::bigint IS NULL OR (approvals.requested_at, approvals.id) < (${microsecondsToTimestamp('$4')}, $5::uuid))
        ORDER BY approvals.requested_at DESC, approvals.id DESC
        LIMIT $6`,
      [filter.status, filter.actionType, filter.unreviewedBreakGlass, position?.micros.toString() ?? null, position?.id ?? null, limit],
    )) as (ApprovalRow & { sort_micros: string })[];
    return rows.map((row) => ({ item: toApproval(row), position: { micros: BigInt(row.sort_micros), id: row.id } }));
  }

  /** The approvals that named a break (its detail view links them). */
  async forBreak(breakId: string): Promise<Approval[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT ${COLUMNS} FROM approvals WHERE approvals.break_id = $1 ORDER BY approvals.requested_at, approvals.id`,
      [breakId],
    )) as ApprovalRow[];
    return rows.map(toApproval);
  }

  private async transition(sql: string, parameters: unknown[]): Promise<Approval> {
    const [row] = (await this.unitOfWork
      .requireTransaction()
      .query(`WITH updated AS (${sql} RETURNING *) SELECT ${COLUMNS.replaceAll('approvals.', 'updated.')} FROM updated`, parameters)) as ApprovalRow[];
    if (!row) {
      // Callers lock the row and check its state first, so a miss means the rules were bypassed.
      throw new InvariantViolationError('The approval was not in the state its transition expected.', { approvalId: parameters[0] });
    }
    return toApproval(row);
  }
}
