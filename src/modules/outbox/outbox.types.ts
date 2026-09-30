/** Versioned event types (design §7.6): events outlive the code that wrote them. */
export enum OutboxEventType {
  EMAIL_VERIFICATION_REQUESTED = 'EmailVerificationRequested.v1',
  EXISTING_ACCOUNT_REGISTRATION_ATTEMPTED = 'ExistingAccountRegistrationAttempted.v1',
  CONVERSION_POSTED = 'ConversionPosted.v1',
  RECONCILIATION_BREAK_CHANGED = 'ReconciliationBreakChanged.v1',
  /** Every approval transition (Phase 10): notify approvers, feed alert routing. Acknowledged for now. */
  APPROVAL_CHANGED = 'ApprovalChanged.v1',
  /** A single-actor override was used: pages the security channel at once (design §9.2). */
  BREAK_GLASS_USED = 'BreakGlassUsed.v1',
  /** A break-glass use went unreviewed past its window: pages again. */
  BREAK_GLASS_REVIEW_OVERDUE = 'BreakGlassReviewOverdue.v1',
  /** An approved rate override / manual rate: the worker offers the snapshot to the Redis cache. */
  EXCHANGE_RATE_OVERRIDDEN = 'ExchangeRateOverridden.v1',
}

/** Payloads carry opaque ids only — no personal data, no credentials (design §9.5). */
export interface UserEventPayload {
  readonly userId: string;
}

/** `ConversionPosted.v1`: aggregate = the transaction. Ids only. */
export interface ConversionPostedPayload {
  readonly transactionId: string;
  readonly userId: string;
  readonly flowId: string;
  /** The quote a trade executed; null for a market conversion. */
  readonly quoteId: string | null;
}

/** `ReconciliationBreakChanged.v1`: aggregate = the break. Ids and codes only (Phase 10's admin consumes it). */
export interface ReconciliationBreakChangedPayload {
  readonly breakId: string;
  readonly type: string;
  readonly status: string;
}

/** `ApprovalChanged.v1`: aggregate = the approval. Ids and codes only. */
export interface ApprovalChangedPayload {
  readonly approvalId: string;
  readonly actionType: string;
  readonly status: string;
}

/** `BreakGlassUsed.v1` / `BreakGlassReviewOverdue.v1`: aggregate = the approval. */
export interface BreakGlassPayload {
  readonly approvalId: string;
  readonly actionType: string;
  readonly actorId: string;
}

/** `ExchangeRateOverridden.v1`: aggregate = the new ACCEPTED snapshot. */
export interface ExchangeRateOverriddenPayload {
  readonly snapshotId: string;
  readonly approvalId: string;
}

export interface ClaimedOutboxEvent {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly payload: unknown;
  /** Including this one. */
  readonly attempts: number;
}

/**
 * A consumer. Delivery is at-least-once, so `handle` must be idempotent: the same event
 * (same `id`) may arrive again after a crash between handling and recording it.
 */
export interface OutboxEventHandler {
  readonly eventType: OutboxEventType;
  handle(event: ClaimedOutboxEvent): Promise<void>;
}
