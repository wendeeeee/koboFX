import { DomainError, ErrorCode } from '../../errors';

export class IdempotencyKeyRequiredError extends DomainError {
  readonly code = ErrorCode.IDEMPOTENCY_KEY_REQUIRED;
  readonly httpStatus = 400;

  constructor() {
    super('This endpoint requires an Idempotency-Key header.');
  }
}

export class IdempotencyKeyInvalidError extends DomainError {
  readonly code = ErrorCode.IDEMPOTENCY_KEY_INVALID;
  readonly httpStatus = 400;

  constructor() {
    super('Idempotency-Key must be 16 to 128 characters of letters, digits, "-" and "_".');
  }
}

export class IdempotencyKeyReuseError extends DomainError {
  readonly code = ErrorCode.IDEMPOTENCY_KEY_REUSE;
  readonly httpStatus = 409;

  constructor() {
    super('This Idempotency-Key was already used with a different request. Use a new key for a new request.');
  }
}

/** Another request with this key is being processed right now. Transient: retry with the same key. */
export class RequestInProgressError extends DomainError {
  readonly code = ErrorCode.REQUEST_IN_PROGRESS;
  readonly httpStatus = 409;
  override readonly permanent = false;
  override readonly retryAfterSeconds = 1;

  constructor() {
    super('A request with this Idempotency-Key is still being processed. Retry shortly with the same key.');
  }
}

/**
 * Not a failure: carries a stored response (a replay, or a permanent error just stored)
 * to `AllExceptionsFilter`, which writes its bytes verbatim — so a replay is
 * byte-identical to the original.
 */
export class StoredResponse extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: string,
    readonly replayed: boolean,
  ) {
    super('stored idempotent response');
    this.name = 'StoredResponse';
  }
}
