import { HttpException, HttpStatus } from '@nestjs/common';
import { DomainError, ErrorCode, ErrorDetails } from '../errors';
import { translateDatabaseError } from '../../database/database-errors';

/** The public error contract (design §12.1). */
export interface ErrorBody {
  statusCode: number;
  code: ErrorCode;
  message: string;
  details?: ErrorDetails;
  correlationId: string | null;
  timestamp: string;
}

export interface ErrorResponse {
  status: number;
  body: ErrorBody;
  headers: Record<string, string>;
  /** True when this is our fault and must be logged with its stack. */
  isServerError: boolean;
}

const HTTP_STATUS_CODES: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_FAILED,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.PAYLOAD_TOO_LARGE]: ErrorCode.PAYLOAD_TOO_LARGE,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
};

const GENERIC_SERVER_MESSAGE = 'An unexpected error occurred.';

/** Errors thrown by Express middleware (e.g. body-parser) before Nest routing. */
interface ExpressHttpError {
  status?: unknown;
  statusCode?: unknown;
  type?: unknown;
  expose?: unknown;
  message?: unknown;
}

function expressStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as ExpressHttpError;
  const status = e.status ?? e.statusCode;
  return typeof status === 'number' && status >= 400 && status < 600 && e.expose === true
    ? status
    : undefined;
}

/**
 * Map anything thrown to the error contract. Pure, so it is unit-testable.
 *
 * Never leaks internals: unknown errors and invariant violations get a generic
 * message on the wire (the detail goes to the log, keyed by correlation id).
 */
export function buildErrorResponse(
  exception: unknown,
  correlationId: string | null,
  now: Date = new Date(),
): ErrorResponse {
  const error = translateDatabaseError(exception);
  const timestamp = now.toISOString();
  const headers: Record<string, string> = {};

  if (error instanceof DomainError) {
    const isServerError = error.httpStatus >= 500 && error.code !== ErrorCode.RESOURCE_BUSY;
    if (error.retryAfterSeconds !== undefined) headers['Retry-After'] = String(error.retryAfterSeconds);
    const exposeDetail = error.httpStatus < 500 || error.code === ErrorCode.RESOURCE_BUSY;
    return {
      status: error.httpStatus,
      headers,
      isServerError,
      body: {
        statusCode: error.httpStatus,
        code: error.code,
        message: exposeDetail ? error.message : GENERIC_SERVER_MESSAGE,
        ...(exposeDetail && error.details ? { details: error.details } : {}),
        correlationId,
        timestamp,
      },
    };
  }

  if (error instanceof HttpException) {
    const status = error.getStatus();
    const response = error.getResponse();
    const raw =
      typeof response === 'object' && response !== null
        ? (response as { message?: unknown }).message
        : response;
    const violations = Array.isArray(raw) ? raw.map(String) : undefined;
    const message = violations
      ? 'Request validation failed.'
      : typeof raw === 'string' && status < 500
        ? raw
        : status < 500
          ? error.message
          : GENERIC_SERVER_MESSAGE;
    return {
      status,
      headers,
      isServerError: status >= 500,
      body: {
        statusCode: status,
        code: HTTP_STATUS_CODES[status] ?? (status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.HTTP_ERROR),
        message,
        ...(violations ? { details: { violations } } : {}),
        correlationId,
        timestamp,
      },
    };
  }

  const status = expressStatus(error);
  if (status !== undefined && status < 500) {
    const message = (error as ExpressHttpError).message;
    return {
      status,
      headers,
      isServerError: false,
      body: {
        statusCode: status,
        code: HTTP_STATUS_CODES[status] ?? ErrorCode.HTTP_ERROR,
        message: typeof message === 'string' ? message : 'Bad request.',
        correlationId,
        timestamp,
      },
    };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    headers,
    isServerError: true,
    body: {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: GENERIC_SERVER_MESSAGE,
      correlationId,
      timestamp,
    },
  };
}
