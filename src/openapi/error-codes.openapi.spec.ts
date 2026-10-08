import { HttpException, HttpStatus } from '@nestjs/common';
import { DomainError, ErrorCode } from '../common/errors';
import * as commonErrors from '../common/errors/domain-error';
import { buildErrorResponse } from '../common/filters/error-response';
import * as providerErrors from '../common/http/provider.errors';
import * as idempotencyErrors from '../common/interceptors/idempotency/idempotency.errors';
import * as adminErrors from '../modules/admin/admin.errors';
import * as authErrors from '../modules/auth/auth.errors';
import * as flowErrors from '../modules/flows/flow.errors';
import * as fundingErrors from '../modules/flows/funding/funding.errors';
import * as fxErrors from '../modules/fx/fx.errors';
import * as ledgerErrors from '../modules/ledger/ledger.errors';
import * as paymentErrors from '../modules/payments/payment.errors';
import * as reconciliationErrors from '../modules/reconciliation/reconciliation.errors';
import * as reservationErrors from '../modules/reservations/reservation.errors';
import * as tradingErrors from '../modules/trading/trading.errors';
import * as transactionErrors from '../modules/transactions/transactions.errors';
import { ERROR_CODE_DESCRIPTIONS, ERROR_CODE_HTTP_STATUS, TRANSIENT_ERROR_CODES } from './error-codes.openapi';
import { errorExample } from './error-response.openapi';


const MODULES = [
  commonErrors,
  providerErrors,
  idempotencyErrors,
  adminErrors,
  authErrors,
  flowErrors,
  fundingErrors,
  fxErrors,
  ledgerErrors,
  paymentErrors,
  reconciliationErrors,
  reservationErrors,
  tradingErrors,
  transactionErrors,
];

type ErrorClass = new (...args: unknown[]) => DomainError;

function domainErrorClasses(): ErrorClass[] {
  const classes = new Set<ErrorClass>();
  for (const module of MODULES) {
    for (const value of Object.values(module)) {
      if (typeof value === 'function' && value.prototype instanceof DomainError) classes.add(value as ErrorClass);
    }
  }
  return [...classes];
}


const ARGUMENT_SHAPES: unknown[][] = [['x', {}], ['x', new Date()], [{}, 1]];

function instantiate(errorClass: ErrorClass): DomainError {
  for (const args of ARGUMENT_SHAPES) {
    try {
      return new errorClass(...args);
    } catch {
      // the next shape
    }
  }
  throw new Error(`Cannot construct ${errorClass.name} for the status check.`);
}

describe('ERROR_CODE_HTTP_STATUS', () => {
  const classes = domainErrorClasses();

  it('finds the error classes (the scan is not vacuous)', () => {
    expect(classes.length).toBeGreaterThan(45);
  });

  it.each(classes.map((errorClass) => [errorClass.name, errorClass]))('%s is sent with the documented status', (_name, errorClass) => {
    const error = instantiate(errorClass as ErrorClass);
    expect({ code: error.code, status: error.httpStatus }).toEqual({ code: error.code, status: ERROR_CODE_HTTP_STATUS[error.code] });
    const { status, body } = buildErrorResponse(error, 'c');
    expect({ status, code: body.code }).toEqual({ status: ERROR_CODE_HTTP_STATUS[error.code], code: error.code });
  });

  it('every transient DomainError code is listed as transient, and only those', () => {
    const transient = new Set(classes.map(instantiate).filter((error) => !error.permanent).map((error) => error.code));
    transient.delete(ErrorCode.RECONCILIATION_RUN_LEASE_LOST); // internal (worker), never on the HTTP surface
    transient.add(ErrorCode.RATE_LIMITED); // RateLimitedError is in common/errors with permanent = false too
    expect([...transient].sort()).toEqual([...TRANSIENT_ERROR_CODES].sort());
  });

  it('pins the codes only the exception filter raises', () => {
    expect(buildErrorResponse(new HttpException('too big', HttpStatus.PAYLOAD_TOO_LARGE), 'c').body.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
    expect(ERROR_CODE_HTTP_STATUS[ErrorCode.PAYLOAD_TOO_LARGE]).toBe(413);
    expect(buildErrorResponse(new Error('boom'), 'c')).toMatchObject({ status: 500, body: { code: ErrorCode.INTERNAL_ERROR } });
    expect(ERROR_CODE_HTTP_STATUS[ErrorCode.INTERNAL_ERROR]).toBe(500);
    expect(buildErrorResponse(new HttpException('nope', HttpStatus.METHOD_NOT_ALLOWED), 'c').body.code).toBe(ErrorCode.HTTP_ERROR);
  });

  it('describes every code, and every example is in the §12.1 shape with the right status', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(ERROR_CODE_DESCRIPTIONS[code].length).toBeGreaterThan(10);
      const example = errorExample(code);
      expect(Object.keys(example).sort()).toEqual(
        ['code', 'correlationId', 'message', 'statusCode', 'timestamp', ...(example.details ? ['details'] : [])].sort(),
      );
      expect(example).toMatchObject({ code, statusCode: ERROR_CODE_HTTP_STATUS[code] });
      // Amounts in details are strings, never numbers.
      for (const [key, value] of Object.entries(example.details ?? {})) {
        if (/Minor$|amount/i.test(key)) expect(typeof value).toBe('string');
      }
    }
  });
});
