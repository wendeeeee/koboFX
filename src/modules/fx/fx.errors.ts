import { DomainError, ErrorCode } from '../../common/errors';

/**
 * No rate may be executed against right now (design §7.4: "a stale rate may be
 * displayed; it may never be executed against"). Transient: behind the idempotency
 * barrier the key is never stored, so a retry with the same key reprocesses.
 */
export class FxRateStaleError extends DomainError {
  readonly code = ErrorCode.FX_RATE_STALE;
  readonly httpStatus = 503;
  override readonly permanent = false;
  override readonly retryAfterSeconds: number;

  constructor(details: Record<string, unknown>, retryAfterSeconds = 30) {
    super('The exchange rate is too old to execute against. Retry shortly.', details);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** No rate can be served at all (none fetched, or older than the display window, §7.4 / §16). */
export class FxRateUnavailableError extends DomainError {
  readonly code = ErrorCode.FX_RATE_UNAVAILABLE;
  readonly httpStatus = 503;
  override readonly permanent = false;
  override readonly retryAfterSeconds = 60;

  constructor(details?: Record<string, unknown>) {
    super('Exchange rates are temporarily unavailable. Retry shortly.', details);
  }
}

export class SameCurrencyError extends DomainError {
  readonly code = ErrorCode.SAME_CURRENCY;
  readonly httpStatus = 400;

  constructor(currency: string) {
    super('Source and target currency must differ.', { currency });
  }
}

/** Both currencies are supported, but this direction is not traded (no active `currency_pairs` row). */
export class UnsupportedCurrencyPairError extends DomainError {
  readonly code = ErrorCode.UNSUPPORTED_CURRENCY_PAIR;
  readonly httpStatus = 400;

  constructor(from: string, to: string) {
    super(`Converting ${from} to ${to} is not supported.`, { from, to });
  }
}

/** Absent, or another user's: never 403 — no existence leak (design §7.7). */
export class QuoteNotFoundError extends DomainError {
  readonly code = ErrorCode.QUOTE_NOT_FOUND;
  readonly httpStatus = 404;

  constructor(quoteId: string) {
    super('Quote not found.', { quoteId });
  }
}

export class QuoteExpiredError extends DomainError {
  readonly code = ErrorCode.QUOTE_EXPIRED;
  readonly httpStatus = 409;

  constructor(quoteId: string, expiresAt: Date) {
    super('The quote has expired. Request a new one.', { quoteId, expiresAt: expiresAt.toISOString() });
  }
}

export class QuoteAlreadyUsedError extends DomainError {
  readonly code = ErrorCode.QUOTE_ALREADY_USED;
  readonly httpStatus = 409;

  constructor(quoteId: string) {
    super('The quote has already been used.', { quoteId });
  }
}

/** Our own provider request budget is spent (Phase 6 §5.3). Thrown before an attempt; nothing is sent. */
export class ProviderRequestBudgetSpentError extends Error {
  constructor(
    readonly period: 'MONTH' | 'DAY',
    readonly used: number,
    readonly budget: number,
  ) {
    super(`FX provider request budget spent for the ${period.toLowerCase()} (${used}/${budget})`);
    this.name = 'ProviderRequestBudgetSpentError';
  }
}
