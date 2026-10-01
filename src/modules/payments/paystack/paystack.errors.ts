import { DependencyUnavailableError } from '../../../common/errors';

/**
 * Paystack refused an initialize because the reference is already used (`400 "Duplicate Transaction Reference"`): a
 * previous attempt WAS accepted and its answer was lost. Never re-sent with another reference; the caller reads the
 * transaction back with `verify` (PAYSTACK_PLAN.md C1). Transient as an HTTP error (it never reaches a client).
 */
export class PaystackDuplicateReferenceError extends DependencyUnavailableError {
  constructor(
    readonly reference: string,
    message = `Paystack already has a transaction with reference ${reference}.`,
  ) {
    super(message, { reference });
  }
}
