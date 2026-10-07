import { DomainError, ErrorCode } from '../../common/errors';

/** New beneficiaries and withdrawals are switched off, or no worker can process them. Transient: no key is stored. */
export class WithdrawalsDisabledError extends DomainError {
  readonly code = ErrorCode.WITHDRAWALS_DISABLED;
  readonly httpStatus = 503;
  override readonly permanent = false;
  override readonly retryAfterSeconds = 30;
}

export class WithdrawalNotFoundError extends DomainError {
  readonly code = ErrorCode.WITHDRAWAL_NOT_FOUND;
  readonly httpStatus = 404;

  constructor(withdrawalId: string) {
    super('Withdrawal not found.', { withdrawalId });
  }
}

export class BeneficiaryNotFoundError extends DomainError {
  readonly code = ErrorCode.WITHDRAWAL_BENEFICIARY_NOT_FOUND;
  readonly httpStatus = 404;

  constructor(beneficiaryId: string) {
    super('Beneficiary not found.', { beneficiaryId });
  }
}

export class BeneficiaryNotReadyError extends DomainError {
  readonly code = ErrorCode.BENEFICIARY_NOT_READY;
  readonly httpStatus = 409;

  constructor(beneficiaryId: string, status: string) {
    super('The beneficiary is not READY.', { beneficiaryId, status });
  }
}

/**
 * The withdrawal code does not authorize this withdrawal: wrong, expired, exhausted (5 wrong tries), superseded by a
 * newer code, or already used by another withdrawal. Permanent (stored for the Idempotency-Key): ask for a new code
 * and send it with a new key. Deliberately one answer for every case.
 */
export class WithdrawalCodeInvalidError extends DomainError {
  readonly code = ErrorCode.WITHDRAWAL_CODE_INVALID;
  readonly httpStatus = 400;

  constructor() {
    super('That withdrawal code is not valid. Request a new code and try again.');
  }
}
