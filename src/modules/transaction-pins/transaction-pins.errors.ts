import { DomainError, ErrorCode } from '../../common/errors';

export class TransactionPinNotSetError extends DomainError {
  readonly code = ErrorCode.TRANSACTION_PIN_NOT_SET;
  readonly httpStatus = 409;

  constructor() {
    super('Create your transaction PIN first.');
  }
}

export class TransactionPinAlreadySetError extends DomainError {
  readonly code = ErrorCode.TRANSACTION_PIN_ALREADY_SET;
  readonly httpStatus = 409;

  constructor() {
    super('You already have a transaction PIN. Change it, or reset it if you forgot it.');
  }
}

/** A wrong PIN. Counted durably; `attemptsRemaining` before it locks. */
export class TransactionPinInvalidError extends DomainError {
  readonly code = ErrorCode.TRANSACTION_PIN_INVALID;
  readonly httpStatus = 400;

  constructor(attemptsRemaining: number) {
    super('Incorrect transaction PIN.', { attemptsRemaining });
  }
}

/** Locked after too many wrong PINs; only a reset (password + emailed code) unlocks it. */
export class TransactionPinLockedError extends DomainError {
  readonly code = ErrorCode.TRANSACTION_PIN_LOCKED;
  readonly httpStatus = 423;

  constructor() {
    super('Your transaction PIN is locked after too many wrong attempts. Reset it to continue.', { resetRequired: true });
  }
}

export class TransactionPinTooWeakError extends DomainError {
  readonly code = ErrorCode.TRANSACTION_PIN_TOO_WEAK;
  readonly httpStatus = 400;

  constructor(reason: string) {
    super(`Choose another PIN: it ${reason}.`, { reason });
  }
}

export class TransactionPinResetCodeInvalidError extends DomainError {
  readonly code = ErrorCode.TRANSACTION_PIN_RESET_CODE_INVALID;
  readonly httpStatus = 400;

  constructor() {
    super('That reset code is not valid. Request a new code and try again.');
  }
}

export class PasswordIncorrectError extends DomainError {
  readonly code = ErrorCode.PASSWORD_INCORRECT;
  readonly httpStatus = 400;

  constructor() {
    super('Your password is incorrect.');
  }
}
