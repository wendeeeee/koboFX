import { DependencyUnavailableError, DomainError, ErrorCode } from '../errors';

/**
 * A provider could not give us an answer: a timeout, a network error, a 5xx, a 429, a
 * `200` carrying an error body. For a write, the outcome is UNKNOWN — the provider may
 * have acted. Transient: callers retry (reads) or re-query (writes).
 */
export class ProviderUnavailableError extends DependencyUnavailableError {
  constructor(
    message: string,
    readonly operation: string,
    readonly responseStatus?: number,
  ) {
    super(message, { operation, ...(responseStatus !== undefined ? { responseStatus } : {}) });
  }
}

/**
 * The provider answered, but a field we USE is missing or malformed (handbook: don't trust
 * the schema — fail loudly, let nothing malformed into the system). Treated as
 * transient for retries (the next answer may be fine) and logged at error level.
 */
export class ProviderResponseInvalidError extends DependencyUnavailableError {
  constructor(
    message: string,
    readonly operation: string,
  ) {
    super(message, { operation });
  }
}

/** A definitive refusal (4xx with an error body): e.g. not found, conflict, bad request. */
export class ProviderRequestRejectedError extends DomainError {
  readonly code = ErrorCode.DEPENDENCY_UNAVAILABLE;
  readonly httpStatus = 503;

  constructor(
    message: string,
    readonly operation: string,
    readonly responseStatus: number,
    readonly providerErrorCode: string | null,
  ) {
    super(message, { operation, responseStatus, providerErrorCode });
  }
}
