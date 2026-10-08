import { DomainError, ErrorCode } from '../../common/errors';


export class PriceLimitExceededError extends DomainError {
  readonly code = ErrorCode.PRICE_LIMIT_EXCEEDED;
  readonly httpStatus = 409;
}


export class DailyLimitExceededError extends DomainError {
  readonly code = ErrorCode.DAILY_LIMIT_EXCEEDED;
  readonly httpStatus = 422;
}
