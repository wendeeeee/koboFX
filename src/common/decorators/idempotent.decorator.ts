import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotency:options';

export interface IdempotentOptions {
  /** A field of the success body holding the flow the request started, linked on the key row. */
  readonly flowIdField?: string;
  /** A field of the success body holding the ledger transaction the request posted, linked on the key row. */
  readonly transactionIdField?: string;
  /**
   * The body carries PII (a beneficiary's account number): hash it with HMAC-SHA256 under the active
   * `IDEMPOTENCY_REQUEST_HASH_KEYS` key, never a plain SHA-256 an attacker with the table could test guesses against
   * (WITHDRAWAL_PLAN.md §H). Each key row records its algorithm and key; replays are checked with those, forever.
   */
  readonly keyedRequestHash?: boolean;
}

/**
 * Put a mutating route behind the idempotency barrier (design §6.5, §12: every mutating
 * endpoint requires `Idempotency-Key`). The handler must be database-only: it runs
 * inside the barrier's transaction (never a third-party call inside a transaction).
 */
export const Idempotent = (options: IdempotentOptions = {}): MethodDecorator => SetMetadata(IDEMPOTENT_KEY, options);
