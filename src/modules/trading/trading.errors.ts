import { DomainError, ErrorCode } from '../../common/errors';

/**
 * A market conversion priced worse than the caller's bound (`minimumTargetAmount` in
 * SOURCE mode, `maximumSourceAmount` in TARGET mode). Permanent: the same key replays it;
 * the caller retries with a new key and, if still willing, a new bound. The details carry
 * the priced amounts so the client can show what the market offered.
 */
export class PriceLimitExceededError extends DomainError {
  readonly code = ErrorCode.PRICE_LIMIT_EXCEEDED;
  readonly httpStatus = 409;
}

/**
 * The conversion would take the user past the rolling 24-hour limit for its source
 * currency (`CONVERSION_LIMITS.{currency}.dailyMaximum`). Permanent for that key.
 */
export class DailyLimitExceededError extends DomainError {
  readonly code = ErrorCode.DAILY_LIMIT_EXCEEDED;
  readonly httpStatus = 422;
}
