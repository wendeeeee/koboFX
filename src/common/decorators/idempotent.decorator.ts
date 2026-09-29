import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotency:options';

export interface IdempotentOptions {
  /** A field of the success body holding the flow the request started, linked on the key row. */
  readonly flowIdField?: string;
  /** A field of the success body holding the ledger transaction the request posted, linked on the key row. */
  readonly transactionIdField?: string;
}

/**
 * Put a mutating route behind the idempotency barrier (design §6.5, §12: every mutating
 * endpoint requires `Idempotency-Key`). The handler must be database-only: it runs
 * inside the barrier's transaction (never a third-party call inside a transaction).
 */
export const Idempotent = (options: IdempotentOptions = {}): MethodDecorator => SetMetadata(IDEMPOTENT_KEY, options);
