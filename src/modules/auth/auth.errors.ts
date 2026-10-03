import { DomainError, ErrorCode } from '../../common/errors';


export class InvalidCredentialsError extends DomainError {
  readonly code = ErrorCode.INVALID_CREDENTIALS;
  readonly httpStatus = 401;

  constructor() {
    super('The email or password is incorrect, or the email has not been verified yet.');
  }
}

/** Verification failed. */
export class VerificationFailedError extends DomainError {
  readonly code = ErrorCode.VERIFICATION_FAILED;
  readonly httpStatus = 400;

  constructor() {
    super('The verification code is invalid or has expired, or the password is incorrect. Request a new code if needed.');
  }
}

export class AccountSuspendedError extends DomainError {
  readonly code = ErrorCode.ACCOUNT_SUSPENDED;
  readonly httpStatus = 403;

  constructor() {
    super('This account is suspended.');
  }
}

export class EmailNotVerifiedError extends DomainError {
  readonly code = ErrorCode.EMAIL_NOT_VERIFIED;
  readonly httpStatus = 403;

  constructor() {
    super('Verify your email to use this feature.');
  }
}
