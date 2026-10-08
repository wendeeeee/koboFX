import { DomainError, ErrorCode } from '../../common/errors';


export class InvalidCursorError extends DomainError {
  readonly code = ErrorCode.INVALID_CURSOR;
  readonly httpStatus = 400;

  constructor(reason: string) {
    super('The cursor is not valid for this query. Start again from the first page.', { reason });
  }
}


export class TransactionNotFoundError extends DomainError {
  readonly code = ErrorCode.TRANSACTION_NOT_FOUND;
  readonly httpStatus = 404;

  constructor(reference: string) {
    super('Transaction not found.', { reference });
  }
}
