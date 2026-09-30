import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { RefreshTokenRevocationReason } from '../auth/tokens/refresh-token-rotation';
import { UserRole, UserStatus } from '../users/user.types';

export enum AuditAction {
  USER_REGISTERED = 'USER_REGISTERED',
  PENDING_REGISTRATION_PASSWORD_REPLACED = 'PENDING_REGISTRATION_PASSWORD_REPLACED',
  USER_VERIFIED = 'USER_VERIFIED',
  REFRESH_TOKEN_FAMILY_REVOKED = 'REFRESH_TOKEN_FAMILY_REVOKED',
  FUNDING_INITIATED = 'FUNDING_INITIATED',
  FUNDING_STATE_CHANGED = 'FUNDING_STATE_CHANGED',
  CONVERSION_POSTED = 'CONVERSION_POSTED',
  SETTLEMENT_POSTED = 'SETTLEMENT_POSTED',
  SETTLEMENT_REJECTED = 'SETTLEMENT_REJECTED',
  RECONCILIATION_BREAK_DETECTED = 'RECONCILIATION_BREAK_DETECTED',
  RECONCILIATION_BREAK_ESCALATED = 'RECONCILIATION_BREAK_ESCALATED',
  RECONCILIATION_BREAK_RESOLVED = 'RECONCILIATION_BREAK_RESOLVED',
  // Controls (Phase 10): the approval is part of the trail (design §9.2).
  APPROVAL_REQUESTED = 'APPROVAL_REQUESTED',
  APPROVAL_APPROVED = 'APPROVAL_APPROVED',
  APPROVAL_REJECTED = 'APPROVAL_REJECTED',
  APPROVAL_CANCELLED = 'APPROVAL_CANCELLED',
  APPROVAL_EXPIRED = 'APPROVAL_EXPIRED',
  APPROVAL_EXECUTED = 'APPROVAL_EXECUTED',
  APPROVAL_EXECUTION_FAILED = 'APPROVAL_EXECUTION_FAILED',
  BREAK_GLASS_USED = 'BREAK_GLASS_USED',
  BREAK_GLASS_REVIEWED = 'BREAK_GLASS_REVIEWED',
  BREAK_GLASS_REVIEW_OVERDUE = 'BREAK_GLASS_REVIEW_OVERDUE',
  ROLE_GRANTED = 'ROLE_GRANTED',
  ROLE_REVOKED = 'ROLE_REVOKED',
  USER_SUSPENDED = 'USER_SUSPENDED',
  USER_REINSTATED = 'USER_REINSTATED',
  CURRENCY_PAIR_CHANGED = 'CURRENCY_PAIR_CHANGED',
  EXCHANGE_RATE_OVERRIDDEN = 'EXCHANGE_RATE_OVERRIDDEN',
  PERIOD_CLOSED = 'PERIOD_CLOSED',
  CORRECTION_POSTED = 'CORRECTION_POSTED',
  WRITE_OFF_POSTED = 'WRITE_OFF_POSTED',
  /** Written by `bootstrap_first_administrators` itself (SQL), listed here so the vocabulary is complete. */
  ADMINISTRATORS_BOOTSTRAPPED = 'ADMINISTRATORS_BOOTSTRAPPED',
}

export enum AuditSubjectType {
  USER = 'USER',
  REFRESH_TOKEN_FAMILY = 'REFRESH_TOKEN_FAMILY',
  FLOW = 'FLOW',
  SETTLEMENT_BATCH = 'SETTLEMENT_BATCH',
  RECONCILIATION_BREAK = 'RECONCILIATION_BREAK',
  APPROVAL = 'APPROVAL',
  EXCHANGE_RATE_SNAPSHOT = 'EXCHANGE_RATE_SNAPSHOT',
  TRANSACTION = 'TRANSACTION',
}

export type AuditActor =
  | { readonly type: 'USER'; readonly id: string }
  | { readonly type: 'OPERATOR'; readonly id: string }
  | { readonly type: 'SYSTEM' };

/**
 * The ONLY fields an audit row may carry in `before`/`after`. Typed on purpose:
 * `audit_logs` can never be deleted, so it must never hold personal data (design
 * §9.5) — no email, no IP address, no password, one-time password or token.
 */
export interface AuditState {
  readonly status?: UserStatus;
  readonly role?: UserRole;
  readonly verified?: boolean;
  readonly revoked?: boolean;
  readonly revocationReason?: RefreshTokenRevocationReason;
  /** A flow's state machine state (design §7.5). */
  readonly flowState?: string;
  /** Why a flow failed: a PSP decline code or our own reason — never card or personal data. */
  readonly failureCode?: string;
  /** The ledger transaction a step posted (an opaque id). */
  readonly transactionId?: string;
  /** Reconciliation (Phase 9): a break's type and lifecycle status — ids and codes only. */
  readonly breakType?: string;
  readonly breakStatus?: string;
  readonly resolutionKind?: string;
  /** A settlement batch's outcome (`POSTED` / `REJECTED`) and why it was refused. */
  readonly settlementStatus?: string;
  readonly rejectionCode?: string;
  /** Controls (Phase 10): an approval's type, status and links — ids and codes only. */
  readonly actionType?: string;
  readonly approvalStatus?: string;
  readonly approvalId?: string;
  readonly breakGlass?: boolean;
  readonly breakId?: string;
  /** A currency pair's pricing before/after a SPREAD_CHANGE (not personal data). */
  readonly currencyPair?: string;
  readonly spreadBasisPoints?: number;
  readonly minimumSourceAmountMinor?: string;
  /** A rate override's snapshots. */
  readonly snapshotId?: string;
  readonly overriddenSnapshotId?: string;
  /** A closed period, `[start, end)`. */
  readonly periodStart?: string;
  readonly periodEnd?: string;
  readonly periodLockId?: string;
}

export interface AuditEntry {
  readonly actor: AuditActor;
  readonly action: AuditAction;
  readonly subject: { readonly type: AuditSubjectType; readonly id: string };
  readonly before?: AuditState;
  readonly after?: AuditState;
  /** The *why* (handbook: audits and audit trails). */
  readonly reason: string;
}

/**
 * Writes `audit_logs` (design §9.3). Must run inside the transaction that makes the
 * change, so the change and its trail commit or roll back together.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async record(entry: AuditEntry): Promise<void> {
    const manager = this.unitOfWork.requireTransaction();
    await manager.query(
      `INSERT INTO audit_logs (actor_type, actor_id, action, subject_type, subject_id, before, after, reason, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.actor.type,
        entry.actor.type === 'SYSTEM' ? null : entry.actor.id,
        entry.action,
        entry.subject.type,
        entry.subject.id,
        entry.before ? JSON.stringify(entry.before) : null,
        entry.after ? JSON.stringify(entry.after) : null,
        entry.reason,
        RequestContext.correlationId() ?? null,
      ],
    );
  }
}
