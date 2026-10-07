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
  // Withdrawals (W2): a data key rewrapped under the active key-encryption key; the sealed facts are untouched.
  DATA_KEY_REWRAPPED = 'DATA_KEY_REWRAPPED',
  BENEFICIARY_REQUESTED = 'BENEFICIARY_REQUESTED',
  BENEFICIARY_STATE_CHANGED = 'BENEFICIARY_STATE_CHANGED',
  WITHDRAWAL_REQUESTED = 'WITHDRAWAL_REQUESTED',
  WITHDRAWAL_STATE_CHANGED = 'WITHDRAWAL_STATE_CHANGED',
  /** W4 §G.2: a protected payout hold needs attention (overdue, orphan, terminal flow, no schedule). Never a release. */
  PROTECTED_HOLD_FLAGGED = 'PROTECTED_HOLD_FLAGGED',
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
  DATA_ENCRYPTION_KEY = 'DATA_ENCRYPTION_KEY',
}

export type AuditActor =
  | { readonly type: 'USER'; readonly id: string }
  | { readonly type: 'OPERATOR'; readonly id: string }
  | { readonly type: 'SYSTEM' };


export interface AuditState {
  readonly status?: UserStatus;
  readonly role?: UserRole;
  readonly verified?: boolean;
  readonly revoked?: boolean;
  readonly revocationReason?: RefreshTokenRevocationReason;
  readonly flowState?: string;
  readonly failureCode?: string;
  readonly transactionId?: string;
  readonly breakType?: string;
  readonly breakStatus?: string;
  readonly resolutionKind?: string;
  readonly settlementStatus?: string;
  readonly rejectionCode?: string;
  readonly actionType?: string;
  readonly approvalStatus?: string;
  readonly approvalId?: string;
  readonly breakGlass?: boolean;
  readonly breakId?: string;
  readonly currencyPair?: string;
  readonly spreadBasisPoints?: number;
  readonly minimumSourceAmountMinor?: string;
  readonly snapshotId?: string;
  readonly overriddenSnapshotId?: string;
  readonly periodStart?: string;
  readonly periodEnd?: string;
  readonly periodLockId?: string;
  readonly keyEncryptionKeyId?: string;
  readonly reservationId?: string;
  readonly holdCondition?: string;
}

export interface AuditEntry {
  readonly actor: AuditActor;
  readonly action: AuditAction;
  readonly subject: { readonly type: AuditSubjectType; readonly id: string };
  readonly before?: AuditState;
  readonly after?: AuditState;
  readonly reason: string;
}

/**
 * Writes `audit_logs`. This action is transaction scoped and must run inside a transaction that makes the
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
