import { DomainError, ErrorCode } from '../../common/errors';

/**
 * Errors raised by the posting engine. Each carries a stable code. Postings are
 * built by our own code, never directly from client input, so structural problems
 * (unbalanced, malformed, mismatched) are 5xx: they mean a bug upstream of the ledger.
 */

/** Debits ≠ credits in some currency. The classic FX-ledger bug (design §5.6). */
export class LedgerUnbalancedError extends DomainError {
  readonly code = ErrorCode.LEDGER_UNBALANCED;
  readonly httpStatus = 500;
}

/** The posting request is structurally wrong (entry count, identifiers, links). */
export class InvalidPostingError extends DomainError {
  readonly code = ErrorCode.INVALID_POSTING;
  readonly httpStatus = 500;
}

/** An entry's currency differs from the currency of the account it hits. */
export class AccountCurrencyMismatchError extends DomainError {
  readonly code = ErrorCode.ACCOUNT_CURRENCY_MISMATCH;
  readonly httpStatus = 500;
}

/** A reversal whose entries do not exactly mirror the original's. */
export class ReversalMismatchError extends DomainError {
  readonly code = ErrorCode.REVERSAL_MISMATCH;
  readonly httpStatus = 500;
}

export class AccountNotFoundError extends DomainError {
  readonly code = ErrorCode.ACCOUNT_NOT_FOUND;
  readonly httpStatus = 404;
}

/** `value_time` falls inside a period already reported to the outside world (design §5.3). */
export class PeriodLockedError extends DomainError {
  readonly code = ErrorCode.PERIOD_LOCKED;
  readonly httpStatus = 409;
}

/** The original already has a correction or reversal; correct the correction instead. */
export class AlreadyCorrectedError extends DomainError {
  readonly code = ErrorCode.ALREADY_CORRECTED;
  readonly httpStatus = 409;
}

/** The balance, even ignoring reservations, cannot cover the debit (design §6.2). */
export class InsufficientFundsError extends DomainError {
  readonly code = ErrorCode.INSUFFICIENT_FUNDS;
  readonly httpStatus = 409;
}

/** The total balance would cover the debit, but part of it is reserved (design §6.3). */
export class FundsReservedError extends DomainError {
  readonly code = ErrorCode.FUNDS_RESERVED;
  readonly httpStatus = 409;
}
