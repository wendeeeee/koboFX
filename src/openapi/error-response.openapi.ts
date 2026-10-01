import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ErrorCode } from '../common/errors';
import { ErrorBody } from '../common/filters/error-response';
import { ERROR_CODE_DESCRIPTIONS, ERROR_CODE_HTTP_STATUS } from './error-codes.openapi';

/** Example correlation id: what `correlationIdMiddleware` generates when the client sends none (a UUID). */
export const EXAMPLE_CORRELATION_ID = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';

/** The error contract (design §12.1), as `AllExceptionsFilter` writes it. Documentation only. */
export class ErrorResponse implements ErrorBody {
  @ApiProperty({ type: 'integer', example: 409, description: 'The HTTP status, repeated.' })
  statusCode!: number;

  @ApiProperty({ enum: ErrorCode, enumName: 'ErrorCode', example: ErrorCode.INSUFFICIENT_FUNDS, description: 'Stable: branch on this, never on `message`.' })
  code!: ErrorCode;

  @ApiProperty({ example: 'The balance cannot cover this debit.', description: 'Human-readable; may change. Generic for our own 5xx faults.' })
  message!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Structured context. Amounts in details are strings of minor units. A DTO validation failure has `violations: string[]`. Never present on our own 5xx faults.',
  })
  details?: Record<string, unknown>;

  @ApiProperty({ type: 'string', nullable: true, example: EXAMPLE_CORRELATION_ID, description: 'Also in the `X-Correlation-Id` response header. Quote it to support.' })
  correlationId!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', example: '2026-09-10T11:04:22.114Z' })
  timestamp!: string;
}

const EXAMPLE_TIMESTAMP = '2026-09-10T11:04:22.114Z';

/** Curated messages and details for the codes clients act on most; the rest use the code's description. */
const CURATED: Partial<Record<ErrorCode, { message: string; details?: Record<string, unknown> }>> = {
  [ErrorCode.INSUFFICIENT_FUNDS]: {
    message: 'The balance cannot cover this debit.',
    details: {
      accountId: '0b6f3c1e-8d2a-4e5b-9c7d-1a2b3c4d5e6f',
      requestedMinor: '100000000',
      balanceMinor: '100000000',
      reservedMinor: '60000000',
      availableMinor: '40000000',
      overdraftLimitMinor: '0',
    },
  },
  [ErrorCode.FUNDS_RESERVED]: {
    message: 'Part of the balance is reserved by another operation.',
    details: {
      accountId: '0b6f3c1e-8d2a-4e5b-9c7d-1a2b3c4d5e6f',
      requestedMinor: '50000000',
      balanceMinor: '100000000',
      reservedMinor: '60000000',
      availableMinor: '40000000',
      overdraftLimitMinor: '0',
    },
  },
  [ErrorCode.VALIDATION_FAILED]: {
    message: 'Request validation failed.',
    details: { violations: ['amount must be a positive whole number of minor units, as a string'] },
  },
  [ErrorCode.RATE_LIMITED]: {
    message: 'Too many requests. Retry after the time given in the Retry-After header.',
    details: { retryAfterSeconds: 42 },
  },
  [ErrorCode.RESOURCE_BUSY]: {
    message: 'The resource is busy. Retry the request with the same Idempotency-Key.',
    details: { reason: 'lock_timeout' },
  },
  [ErrorCode.INVALID_CREDENTIALS]: { message: 'The email or password is incorrect, or the email has not been verified yet.' },
  [ErrorCode.UNAUTHENTICATED]: { message: 'Authentication is required.' },
  [ErrorCode.FORBIDDEN]: { message: 'You do not have permission to do this.' },
  [ErrorCode.INTERNAL_ERROR]: { message: 'An unexpected error occurred.' },
  [ErrorCode.INVARIANT_VIOLATION]: { message: 'An unexpected error occurred.' },
};

/** An example body for one code, in the exact §12.1 shape. */
export function errorExample(code: ErrorCode): ErrorBody {
  const curated = CURATED[code];
  const serverFault = ERROR_CODE_HTTP_STATUS[code] >= 500 && ERROR_CODE_HTTP_STATUS[code] !== 503;
  return {
    statusCode: ERROR_CODE_HTTP_STATUS[code],
    code,
    message: curated?.message ?? (serverFault ? 'An unexpected error occurred.' : ERROR_CODE_DESCRIPTIONS[code]),
    ...(curated?.details ? { details: curated.details } : {}),
    correlationId: EXAMPLE_CORRELATION_ID,
    timestamp: EXAMPLE_TIMESTAMP,
  };
}
