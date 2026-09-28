/** Versioned event types (design §7.6): events outlive the code that wrote them. */
export enum OutboxEventType {
  EMAIL_VERIFICATION_REQUESTED = 'EmailVerificationRequested.v1',
  EXISTING_ACCOUNT_REGISTRATION_ATTEMPTED = 'ExistingAccountRegistrationAttempted.v1',
}

/** Payloads carry opaque ids only — no personal data, no credentials (design §9.5). */
export interface UserEventPayload {
  readonly userId: string;
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
