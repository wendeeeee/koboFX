import { BadRequestException, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import {
  CurrencyMismatchError,
  ErrorCode,
  InvariantViolationError,
  ResourceBusyError,
  UnsupportedCurrencyError,
} from '../errors';
import { buildErrorResponse } from './error-response';

const NOW = new Date('2026-09-10T11:04:22.114Z');
const CID = 'corr-1234';

describe('buildErrorResponse (design §12.1 contract)', () => {
  it('maps a DomainError to its stable code, status and details', () => {
    const r = buildErrorResponse(new UnsupportedCurrencyError('XYZ'), CID, NOW);
    expect(r.status).toBe(400);
    expect(r.isServerError).toBe(false);
    expect(r.body).toEqual({
      statusCode: 400,
      code: ErrorCode.UNSUPPORTED_CURRENCY,
      message: 'Currency "XYZ" is not supported.',
      details: { currency: 'XYZ' },
      correlationId: CID,
      timestamp: '2026-09-10T11:04:22.114Z',
    });
  });

  it('RESOURCE_BUSY is a transient 503 with Retry-After', () => {
    const r = buildErrorResponse(new ResourceBusyError('busy'), CID, NOW);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe(ErrorCode.RESOURCE_BUSY);
    expect(r.headers['Retry-After']).toBe('1');
    expect(r.isServerError).toBe(false);
  });

  it('translates a Postgres lock timeout (55P03) into RESOURCE_BUSY', () => {
    const pgError = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    const r = buildErrorResponse({ driverError: pgError }, CID, NOW);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe(ErrorCode.RESOURCE_BUSY);
    expect(r.body.details).toEqual({ reason: 'lock_timeout' });
  });

  it('invariant violations are 500s that leak nothing', () => {
    const r = buildErrorResponse(new CurrencyMismatchError('NGN', 'USD'), CID, NOW);
    expect(r.status).toBe(500);
    expect(r.isServerError).toBe(true);
    expect(r.body.code).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(r.body.message).toBe('An unexpected error occurred.');
    expect(r.body).not.toHaveProperty('details');
    const leaky = new InvariantViolationError('ledger unbalanced on account 7f3c');
    expect(buildErrorResponse(leaky, CID, NOW).body.message).not.toContain('7f3c');
  });

  it('flattens ValidationPipe errors into VALIDATION_FAILED with violations', () => {
    const r = buildErrorResponse(
      new BadRequestException(['amountMinor must be a string', 'currency should not be empty']),
      CID,
      NOW,
    );
    expect(r.status).toBe(400);
    expect(r.body.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(r.body.details).toEqual({
      violations: ['amountMinor must be a string', 'currency should not be empty'],
    });
  });

  it('maps framework HTTP errors to stable codes', () => {
    expect(buildErrorResponse(new NotFoundException('Cannot GET /x'), CID, NOW).body.code).toBe(
      ErrorCode.NOT_FOUND,
    );
    const r = buildErrorResponse(new InternalServerErrorException('db password is hunter2'), CID, NOW);
    expect(r.body.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(r.body.message).not.toContain('hunter2');
  });

  it('maps body-parser errors (e.g. payload too large) that bypass Nest routing', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      expose: true,
      type: 'entity.too.large',
    });
    const r = buildErrorResponse(tooLarge, CID, NOW);
    expect(r.status).toBe(413);
    expect(r.body.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });

  it('unknown errors become a generic 500 — no stack, no message', () => {
    const r = buildErrorResponse(new TypeError('cannot read secret of undefined'), null, NOW);
    expect(r.status).toBe(500);
    expect(r.isServerError).toBe(true);
    expect(r.body).toEqual({
      statusCode: 500,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'An unexpected error occurred.',
      correlationId: null,
      timestamp: '2026-09-10T11:04:22.114Z',
    });
  });
});
