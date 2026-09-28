import { DomainError, ErrorCode } from '../../common/errors';

export class ReservationNotFoundError extends DomainError {
  readonly code = ErrorCode.RESERVATION_NOT_FOUND;
  readonly httpStatus = 404;
}

/** Settling a reservation its flow already RELEASED. The hold is gone by the flow's own decision. */
export class ReservationNotActiveError extends DomainError {
  readonly code = ErrorCode.RESERVATION_NOT_ACTIVE;
  readonly httpStatus = 409;
}

/**
 * A retry that disagrees with what already happened: a reserve for the same
 * (flow, account) with a different amount, or a second settle with a different actual.
 * The analogue of `IDEMPOTENCY_KEY_REUSE`.
 */
export class ReservationConflictError extends DomainError {
  readonly code = ErrorCode.RESERVATION_CONFLICT;
  readonly httpStatus = 409;
}

/**
 * A malformed request built by our own code, never directly from client input: an
 * internal account, a currency mismatch, an expiry in the past, a settlement posting
 * that does not reduce the reserved account. 5xx — a bug upstream.
 */
export class InvalidReservationError extends DomainError {
  readonly code = ErrorCode.INVALID_RESERVATION;
  readonly httpStatus = 500;
}
