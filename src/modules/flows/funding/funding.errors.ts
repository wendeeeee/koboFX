import { DomainError, ErrorCode, InvariantViolationError } from '../../../common/errors';

export class FundingNotFoundError extends DomainError {
  readonly code = ErrorCode.FUNDING_NOT_FOUND;
  readonly httpStatus = 404;

  constructor(fundingId: string) {
    super('Funding not found.', { fundingId });
  }
}

export class AmountTooSmallError extends DomainError {
  readonly code = ErrorCode.AMOUNT_TOO_SMALL;
  readonly httpStatus = 422;
}

export class AmountTooLargeError extends DomainError {
  readonly code = ErrorCode.AMOUNT_TOO_LARGE;
  readonly httpStatus = 422;
}

/**
 * What the PSP reports for a payment contradicts what we asked for (another amount,
 * currency or reference). Never booked: the flow parks with this as `last_error` and
 * pages through `flows_stalled` (fail loudly; handbook: don't trust the schema).
 */
export class ProviderPaymentMismatchError extends InvariantViolationError {}
