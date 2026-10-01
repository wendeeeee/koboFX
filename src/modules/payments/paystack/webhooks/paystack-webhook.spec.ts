import * as crypto from 'node:crypto';

jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, timingSafeEqual: jest.fn(actual.timingSafeEqual) };
});
import { parsePaystackWebhookHint } from './paystack-webhook-payload';
import { signPaystackWebhook, verifyPaystackSignature } from './paystack-webhook-signature';

// A synthetic key with the shape of a Paystack test key — never a real one.
const key = `sk_test_${'1'.repeat(40)}`;
const body = Buffer.from('{"event":"charge.success","data":{"id":2009945086,"status":"success","reference":"r-1","amount":20000}}');

describe('Paystack webhook signature (PAYSTACK_PLAN.md A6)', () => {
  it('accepts hex HMAC-SHA512 of the raw bytes keyed with the secret key, in either hex case', () => {
    const signature = signPaystackWebhook(key, body);
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyPaystackSignature(signature, body, key)).toEqual({ valid: true });
    expect(verifyPaystackSignature(signature.toUpperCase(), body, key)).toEqual({ valid: true });
  });

  it('refuses another key, one tampered byte, and a re-serialised body', () => {
    expect(verifyPaystackSignature(signPaystackWebhook(`sk_test_${'2'.repeat(40)}`, body), body, key)).toEqual({ valid: false, reason: 'MISMATCH' });
    const tampered = Buffer.from(body);
    tampered[tampered.length - 3] ^= 0x01;
    expect(verifyPaystackSignature(signPaystackWebhook(key, body), tampered, key)).toEqual({ valid: false, reason: 'MISMATCH' });
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 1));
    expect(verifyPaystackSignature(signPaystackWebhook(key, body), reserialised, key).valid).toBe(false);
  });

  it('refuses a missing, empty, odd-length, non-hex or SHA-256-sized header, and an empty key', () => {
    expect(verifyPaystackSignature(undefined, body, key)).toEqual({ valid: false, reason: 'MISSING' });
    expect(verifyPaystackSignature('', body, key)).toEqual({ valid: false, reason: 'MISSING' });
    expect(verifyPaystackSignature('a'.repeat(127), body, key)).toEqual({ valid: false, reason: 'MALFORMED' });
    expect(verifyPaystackSignature('z'.repeat(128), body, key)).toEqual({ valid: false, reason: 'MALFORMED' });
    expect(verifyPaystackSignature('a'.repeat(64), body, key)).toEqual({ valid: false, reason: 'MALFORMED' });
    expect(verifyPaystackSignature(`${signPaystackWebhook(key, body)} `, body, key)).toEqual({ valid: false, reason: 'MALFORMED' });
    expect(verifyPaystackSignature(signPaystackWebhook('', body), body, '')).toEqual({ valid: false, reason: 'MISMATCH' });
  });

  it('compares in constant time (timingSafeEqual over equal-length digests), never with ===', () => {
    const spy = jest.mocked(crypto.timingSafeEqual);
    spy.mockClear();
    verifyPaystackSignature('0'.repeat(128), body, key);
    expect(spy).toHaveBeenCalledTimes(1);
    const [expected, given] = spy.mock.calls[0] as [Buffer, Buffer];
    expect(expected.length).toBe(64);
    expect(given.length).toBe(64);
  });
});

describe('Paystack webhook hint (PAYSTACK_PLAN.md C4)', () => {
  it('reads the event, our reference and the transaction id — never the amount', () => {
    const hint = parsePaystackWebhookHint(body);
    expect(hint).toMatchObject({ eventType: 'charge.success', reference: 'r-1', transactionId: '2009945086' });
    expect(Object.keys(hint ?? {})).toEqual(['providerEventId', 'eventType', 'reference', 'transactionId']);
  });

  it('keeps an id beyond 2^53 exactly (lossless)', () => {
    const hint = parsePaystackWebhookHint(Buffer.from('{"event":"charge.success","data":{"id":12345678901234567890123,"reference":"r"}}'));
    expect(hint?.transactionId).toBe('12345678901234567890123');
  });

  it('a dispute event names the disputed transaction', () => {
    const hint = parsePaystackWebhookHint(
      Buffer.from('{"event":"charge.dispute.resolve","data":{"id":77,"status":"resolved","transaction":{"id":42,"reference":"r-9"}}}'),
    );
    expect(hint).toMatchObject({ eventType: 'charge.dispute.resolve', reference: 'r-9', transactionId: '42' });
  });

  it('the event id: equal for a retried delivery, different for a different event or status', () => {
    const again = parsePaystackWebhookHint(Buffer.from(body.toString().replace('"amount":20000', '"amount":20000 ')));
    expect(again?.providerEventId).toBe(parsePaystackWebhookHint(body)?.providerEventId);
    const other = parsePaystackWebhookHint(Buffer.from(body.toString().replace('charge.success', 'charge.dispute.create')));
    expect(other?.providerEventId).not.toBe(parsePaystackWebhookHint(body)?.providerEventId);
    const failed = parsePaystackWebhookHint(Buffer.from(body.toString().replace('"status":"success"', '"status":"failed"')));
    expect(failed?.providerEventId).not.toBe(parsePaystackWebhookHint(body)?.providerEventId);
  });

  it('garbage or the wrong shape is no hint (stored MALFORMED, never processed)', () => {
    expect(parsePaystackWebhookHint(Buffer.from('not json'))).toBeUndefined();
    expect(parsePaystackWebhookHint(Buffer.from('{"data":{}}'))).toBeUndefined();
    expect(parsePaystackWebhookHint(Buffer.from('{"event":"x"}'))).toBeUndefined();
  });
});
