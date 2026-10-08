import { BadRequestException, HttpException, InternalServerErrorException } from '@nestjs/common';
import { InvariantViolationError, ResourceBusyError, ValidationError } from '../../errors';
import { DependencyUnavailableError } from '../../errors/domain-error';
import { IDEMPOTENCY_KEY_PATTERN, IdempotencyKeyStatus, classifyFailure, decide } from './idempotency-decision';
import { canonicalJson, requestHash } from './request-hash';

const HASH = 'a'.repeat(64);
const stored = (status: IdempotencyKeyStatus, requestHashValue = HASH) => ({
  status,
  requestHash: requestHashValue,
  requestHashAlgorithm: 'SHA256_V1',
  requestHashKeyId: null,
  responseStatusCode: status === IdempotencyKeyStatus.IN_PROGRESS ? null : 202,
  responseBody: status === IdempotencyKeyStatus.IN_PROGRESS ? null : '{"ok":true}',
});

describe('idempotency decisions (design §6.5)', () => {
  it('claim → proceed', () => {
    expect(decide(true, null, HASH)).toEqual({ kind: 'PROCEED' });
  });

  it('replays a stored success verbatim', () => {
    expect(decide(false, stored(IdempotencyKeyStatus.COMPLETED), HASH)).toEqual({ kind: 'REPLAY', statusCode: 202, body: '{"ok":true}' });
  });

  it('replays a stored permanent failure verbatim', () => {
    const failure = { ...stored(IdempotencyKeyStatus.FAILED_PERMANENT), responseStatusCode: 422, responseBody: '{"code":"AMOUNT_TOO_SMALL"}' };
    expect(decide(false, failure, HASH)).toEqual({ kind: 'REPLAY', statusCode: 422, body: '{"code":"AMOUNT_TOO_SMALL"}' });
  });

  it('a different body under the same key is IDEMPOTENCY_KEY_REUSE — even for a stored failure', () => {
    expect(decide(false, stored(IdempotencyKeyStatus.COMPLETED, 'b'.repeat(64)), HASH)).toEqual({ kind: 'KEY_REUSED' });
    expect(decide(false, stored(IdempotencyKeyStatus.FAILED_PERMANENT, 'b'.repeat(64)), HASH)).toEqual({ kind: 'KEY_REUSED' });
  });

  it('in progress (or a row we cannot read) → REQUEST_IN_PROGRESS', () => {
    expect(decide(false, stored(IdempotencyKeyStatus.IN_PROGRESS), HASH)).toEqual({ kind: 'IN_PROGRESS' });
    expect(decide(false, null, HASH)).toEqual({ kind: 'IN_PROGRESS' });
    expect(decide(false, { ...stored(IdempotencyKeyStatus.COMPLETED), responseBody: null }, HASH)).toEqual({ kind: 'IN_PROGRESS' });
  });

  it('classifies failures: permanent (stored, replayed) vs transient (re-processable)', () => {
    expect(classifyFailure(new ValidationError('bad'))).toBe('PERMANENT');
    expect(classifyFailure(new BadRequestException(['amount must be a string']))).toBe('PERMANENT');
    expect(classifyFailure(new HttpException('not found', 404))).toBe('PERMANENT');
    expect(classifyFailure(new ResourceBusyError('busy'))).toBe('TRANSIENT');
    expect(classifyFailure(new DependencyUnavailableError('down'))).toBe('TRANSIENT');
    expect(classifyFailure(new InvariantViolationError('our bug'))).toBe('TRANSIENT');
    expect(classifyFailure(new HttpException('slow down', 429))).toBe('TRANSIENT');
    expect(classifyFailure(new InternalServerErrorException())).toBe('TRANSIENT');
    expect(classifyFailure(new Error('anything else'))).toBe('TRANSIENT');
  });

  it('key format: 16–128 of [A-Za-z0-9_-]; a UUID fits', () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test('0b6c3c3e-6e8b-4c1e-9c31-1d7f5a8e2b44')).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test('a'.repeat(16))).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test('a'.repeat(128))).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test('a'.repeat(15))).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test('a'.repeat(129))).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test('with space and more chars')).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test('semicolon;injection-xx')).toBe(false);
  });
});

describe('request hash (design §0.3 point 1)', () => {
  it('is independent of key order and whitespace, and sensitive to every value', () => {
    const a = requestHash('POST /api/v1/wallet/fund', { amount: '100', currency: 'NGN', nested: { b: 1, a: [2, { d: 1, c: 2 }] } });
    const b = requestHash('POST /api/v1/wallet/fund', { nested: { a: [2, { c: 2, d: 1 }], b: 1 }, currency: 'NGN', amount: '100' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(requestHash('POST /api/v1/wallet/fund', { amount: '101', currency: 'NGN' })).not.toBe(
      requestHash('POST /api/v1/wallet/fund', { amount: '100', currency: 'NGN' }),
    );
    expect(requestHash('POST /api/v1/wallet/other', {})).not.toBe(requestHash('POST /api/v1/wallet/fund', {}));
  });

  it('canonical JSON sorts keys at every depth and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [1, 'x', null] } })).toBe('{"a":{"c":[1,"x",null]},"b":1}');
    expect(canonicalJson(undefined)).toBe('null');
  });
});
