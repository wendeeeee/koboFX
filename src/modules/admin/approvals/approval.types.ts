/**
 * The sensitive actions (design §9.2; Phase 10 plan §B). The database enum `approval_action_type` holds the
 * same values (a spec asserts they match).
 */
export enum ApprovalActionType {
  /** A linked compensating posting that fixes a break (moves CLEARING money, a partial chargeback…). */
  CORRECTION = 'CORRECTION',
  /** An unrecoverable overdraft to `EXPENSE:WRITE_OFF` (design §6.4). */
  WRITE_OFF = 'WRITE_OFF',
  /** Accept a rejected (> 20% jump) fetch, or inject a manual rate (§16). */
  RATE_OVERRIDE = 'RATE_OVERRIDE',
  /** A pair's spread and/or minimum. */
  SPREAD_CHANGE = 'SPREAD_CHANGE',
  SUSPEND_USER = 'SUSPEND_USER',
  REINSTATE_USER = 'REINSTATE_USER',
  /** Lock a reporting month (`period_locks`). */
  CLOSE_PERIOD = 'CLOSE_PERIOD',
  /** Grant or revoke ADMIN / SECURITY. */
  ROLE_CHANGE = 'ROLE_CHANGE',
  /** Close a break with an operator's documented decision (no money moves — still four-eyes). */
  RESOLVE_BREAK = 'RESOLVE_BREAK',
  /** Apply a stored, matched Paystack transfer outcome to a withdrawal (W4, WITHDRAWAL_PLAN.md §I.3). Never sends money. */
  PAYSTACK_WITHDRAWAL_RECOVERY = 'PAYSTACK_WITHDRAWAL_RECOVERY',
}

export const APPROVAL_ACTION_TYPE_VALUES: readonly ApprovalActionType[] = Object.values(ApprovalActionType);

/** An approval's lifecycle (`approval-transitions.ts`; the database enum `approval_status`). */
export enum ApprovalStatus {
  PENDING = 'PENDING',
  /** Decided by a different eligible person; executed in the same transaction (never committed alone). */
  APPROVED = 'APPROVED',
  EXECUTED = 'EXECUTED',
  /** Approved, but the world had moved: re-validation at execution refused it (recorded, terminal). */
  EXECUTION_FAILED = 'EXECUTION_FAILED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

export const APPROVAL_STATUS_VALUES: readonly ApprovalStatus[] = Object.values(ApprovalStatus);

export interface Approval {
  readonly id: string;
  readonly actionType: ApprovalActionType;
  readonly payload: Record<string, unknown>;
  readonly payloadHash: string;
  readonly reason: string;
  readonly status: ApprovalStatus;
  readonly isBreakGlass: boolean;
  readonly breakId: string | null;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
  readonly rejectedBy: string | null;
  readonly rejectedAt: Date | null;
  readonly rejectionReason: string | null;
  readonly cancelledAt: Date | null;
  readonly expiredAt: Date | null;
  readonly executedBy: string | null;
  readonly executedAt: Date | null;
  readonly executionFailureCode: string | null;
  readonly resultReference: string | null;
  readonly breakGlassReviewedBy: string | null;
  readonly breakGlassReviewedAt: Date | null;
  readonly breakGlassReviewNote: string | null;
}
