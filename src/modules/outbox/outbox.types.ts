export enum OutboxEventType {
  EMAIL_VERIFICATION_REQUESTED = 'EmailVerificationRequested.v1',
  EXISTING_ACCOUNT_REGISTRATION_ATTEMPTED = 'ExistingAccountRegistrationAttempted.v1',
  CONVERSION_POSTED = 'ConversionPosted.v1',
  FUNDING_POSTED = 'FundingPosted.v1',
  RECONCILIATION_BREAK_CHANGED = 'ReconciliationBreakChanged.v1',
  APPROVAL_CHANGED = 'ApprovalChanged.v1',
  BREAK_GLASS_USED = 'BreakGlassUsed.v1',
  BREAK_GLASS_REVIEW_OVERDUE = 'BreakGlassReviewOverdue.v1',
  EXCHANGE_RATE_OVERRIDDEN = 'ExchangeRateOverridden.v1',
  BENEFICIARY_CHANGED = 'BeneficiaryChanged.v1',
  WITHDRAWAL_CHANGED = 'WithdrawalChanged.v1',
  PROTECTED_HOLD_FLAGGED = 'ProtectedHoldFlagged.v1',
  /** A user asked for a withdrawal code: `{userId}` (the worker generates and emails it). */
  WITHDRAWAL_CODE_REQUESTED = 'WithdrawalCodeRequested.v1',
}

/** W4 §G.2: ids and the condition only. */
export interface ProtectedHoldFlaggedPayload {
  readonly reservationId: string;
  readonly flowId: string;
  readonly condition: string;
}

export interface UserEventPayload {
  readonly userId: string;
}

export interface ConversionPostedPayload {
  readonly transactionId: string;
  readonly userId: string;
  readonly flowId: string;
  readonly quoteId: string | null;
}

/** Withdrawals (W3): ids and the flow state only — never an account number, name or amount. */
export interface WithdrawalFlowChangedPayload {
  readonly flowId: string;
  readonly userId: string;
  readonly state: string;
}

export interface FundingPostedPayload {
  readonly transactionId: string;
  readonly userId: string;
  readonly flowId: string;
  readonly provider: string;
}


export interface ReconciliationBreakChangedPayload {
  readonly breakId: string;
  readonly type: string;
  readonly status: string;
}

export interface ApprovalChangedPayload {
  readonly approvalId: string;
  readonly actionType: string;
  readonly status: string;
}

export interface BreakGlassPayload {
  readonly approvalId: string;
  readonly actionType: string;
  readonly actorId: string;
}

export interface ExchangeRateOverriddenPayload {
  readonly snapshotId: string;
  readonly approvalId: string;
}

export interface ClaimedOutboxEvent {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly payload: unknown;
  readonly attempts: number;
}


export interface OutboxEventHandler {
  readonly eventType: OutboxEventType;
  handle(event: ClaimedOutboxEvent): Promise<void>;
}
