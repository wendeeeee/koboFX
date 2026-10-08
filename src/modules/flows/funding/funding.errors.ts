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


export class ProviderPaymentMismatchError extends InvariantViolationError {}
