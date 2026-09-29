import { DomainError, ErrorCode } from '../../common/errors';

/**
 * A `cursor` that is not one this API minted for the same query: malformed, of an unknown
 * version, or presented with another sort or other filters. A cursor is input, not a key: it
 * only ever narrows the caller's own rows, so a forged one gains nothing and is merely refused.
 */
export class InvalidCursorError extends DomainError {
  readonly code = ErrorCode.INVALID_CURSOR;
  readonly httpStatus = 400;

  constructor(reason: string) {
    super('The cursor is not valid for this query. Start again from the first page.', { reason });
  }
}

/**
 * No transaction with this reference belongs to the caller. Unknown and another user's
 * references are the same error, with the same body: no existence leak.
 */
export class TransactionNotFoundError extends DomainError {
  readonly code = ErrorCode.TRANSACTION_NOT_FOUND;
  readonly httpStatus = 404;

  constructor(reference: string) {
    super('Transaction not found.', { reference });
  }
}
