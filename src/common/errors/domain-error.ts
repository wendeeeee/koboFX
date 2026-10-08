import { ErrorCode } from './error-codes';

/** Details are part of the public error contract: strings only for amounts, never numbers. */
export type ErrorDetails = Record<string, unknown>;

/**
 * Base of every error the domain raises on purpose. Carries a stable `code`, the
 * HTTP status it maps to, and structured `details` (design §12.1).
 *
 * `permanent` drives idempotent replay (design §6.5): a permanent failure is stored
 * and replayed verbatim; a transient one returns the key to claimable.
 */
export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;
  readonly permanent: boolean = true;
  /** Seconds, surfaced as `Retry-After` on transient failures. */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    readonly details?: ErrorDetails,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  readonly code = ErrorCode.VALIDATION_FAILED;
  readonly httpStatus = 400;
}

export class InvalidAmountError extends DomainError {
  readonly code = ErrorCode.INVALID_AMOUNT;
  readonly httpStatus = 400;
}

export class UnsupportedCurrencyError extends DomainError {
  readonly code = ErrorCode.UNSUPPORTED_CURRENCY;
  readonly httpStatus = 400;

  constructor(currency: string) {
    super(`Currency ${JSON.stringify(currency)} is not supported.`, { currency });
  }
}

export class NotFoundError extends DomainError {
  readonly code = ErrorCode.NOT_FOUND;
  readonly httpStatus = 404;
}

/**
 * Lock wait or statement timeout exceeded (design §6.6). Transient: the client
 * retries with the same idempotency key.
 */
export class ResourceBusyError extends DomainError {
  readonly code = ErrorCode.RESOURCE_BUSY;
  readonly httpStatus = 503;
  override readonly permanent = false;
  override readonly retryAfterSeconds = 1;
}

/** No valid credentials were presented. Deliberately says nothing about which part failed. */
export class UnauthenticatedError extends DomainError {
  readonly code = ErrorCode.UNAUTHENTICATED;
  readonly httpStatus = 401;
}

/** Authenticated, but not allowed to do this. */
export class ForbiddenError extends DomainError {
  readonly code = ErrorCode.FORBIDDEN;
  readonly httpStatus = 403;
}

/** Too many requests (design §9.1). Transient: retry after `retryAfterSeconds`. */
export class RateLimitedError extends DomainError {
  readonly code = ErrorCode.RATE_LIMITED;
  readonly httpStatus = 429;
  override readonly permanent = false;
  override readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('Too many requests. Retry after the time given in the Retry-After header.', { retryAfterSeconds });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * A dependency we cannot work without is unreachable (e.g. Redis for one-time
 * passwords). Fail closed (design §7.1, §16): refuse, never bypass. Transient.
 */
export class DependencyUnavailableError extends DomainError {
  readonly code = ErrorCode.DEPENDENCY_UNAVAILABLE;
  readonly httpStatus = 503;
  override readonly permanent = false;
  override readonly retryAfterSeconds = 5;
}

/**
 * A broken assumption in our own code — never the client's fault. Raised loudly
 * instead of clamping, skipping, or guessing ("fail loudly on broken assumptions").
 */
export class InvariantViolationError extends DomainError {
  readonly code = ErrorCode.INVARIANT_VIOLATION;
  readonly httpStatus = 500;
}

/** Cross-currency arithmetic was attempted. Unrepresentable by construction (design §4.1). */
export class CurrencyMismatchError extends InvariantViolationError {
  constructor(left: string, right: string) {
    super(`Cannot combine ${left} with ${right}: cross-currency arithmetic is forbidden.`, {
      left,
      right,
    });
  }
}
