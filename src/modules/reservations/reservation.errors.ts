import { DomainError, ErrorCode } from '../../common/errors';

export class ReservationNotFoundError extends DomainError {
  readonly code = ErrorCode.RESERVATION_NOT_FOUND;
  readonly httpStatus = 404;
}

export class ReservationNotActiveError extends DomainError {
  readonly code = ErrorCode.RESERVATION_NOT_ACTIVE;
  readonly httpStatus = 409;
}

export class ReservationConflictError extends DomainError {
  readonly code = ErrorCode.RESERVATION_CONFLICT;
  readonly httpStatus = 409;
}


export class InvalidReservationError extends DomainError {
  readonly code = ErrorCode.INVALID_RESERVATION;
  readonly httpStatus = 500;
}
