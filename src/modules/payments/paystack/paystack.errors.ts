import { DependencyUnavailableError } from '../../../common/errors';

export class PaystackDuplicateReferenceError extends DependencyUnavailableError {
  constructor(
    readonly reference: string,
    message = `Paystack already has a transaction with reference ${reference}.`,
  ) {
    super(message, { reference });
  }
}
