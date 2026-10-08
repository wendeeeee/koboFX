import { randomBytes } from 'node:crypto';
import { signWebhook, verifyWebhookSignature } from './webhook-signature';
import { extractProviderEventId, parseWebhookHint } from './webhook-payload';

const secret = randomBytes(32);
const previousSecret = randomBytes(32);
const now = 1_790_000_000;
const body = Buffer.from('{"id":"evt_1","type":"payment.captured","data":{"object":{"id":"pay_1","reference":"r"}}}');

describe('webhook signatures (design §7.3)', () => {
  const verify = (header: string | undefined, bytes = body, secrets = [secret], at = now) =>
    verifyWebhookSignature(header, bytes, secrets, at, 300);

  it('accepts a valid signature over the raw bytes', () => {
    expect(verify(signWebhook(secret, body, now))).toEqual({ valid: true });
  });

  it('refuses a signature made with another secret', () => {
    expect(verify(signWebhook(randomBytes(32), body, now))).toEqual({ valid: false, reason: 'MISMATCH' });
  });

  it('refuses a single tampered byte', () => {
    const tampered = Buffer.from(body);
    tampered[tampered.length - 5] ^= 0x01;
    expect(verify(signWebhook(secret, body, now), tampered)).toEqual({ valid: false, reason: 'MISMATCH' });
  });

  it('refuses re-serialised JSON: same data, different bytes', () => {
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 1));
    expect(JSON.parse(reserialised.toString())).toEqual(JSON.parse(body.toString()));
    expect(verify(signWebhook(secret, body, now), reserialised)).toEqual({ valid: false, reason: 'MISMATCH' });
  });

  it('refuses stale and future timestamps beyond the tolerance, and a moved timestamp', () => {
    expect(verify(signWebhook(secret, body, now - 301))).toEqual({ valid: false, reason: 'STALE' });
    expect(verify(signWebhook(secret, body, now + 301))).toEqual({ valid: false, reason: 'STALE' });
    expect(verify(signWebhook(secret, body, now - 300))).toEqual({ valid: true });
    // Replaying an old signature with a fresh timestamp: the timestamp is inside the MAC.
    const old = signWebhook(secret, body, now - 1000);
    expect(verify(old.replace(/t=\d+/, `t=${now}`))).toEqual({ valid: false, reason: 'MISMATCH' });
  });

  it('accepts either secret during a rotation, and several v1 values', () => {
    expect(verify(signWebhook(previousSecret, body, now), body, [secret, previousSecret])).toEqual({ valid: true });
    expect(verify(signWebhook(previousSecret, body, now), body, [secret])).toEqual({ valid: false, reason: 'MISMATCH' });
    const both = `${signWebhook(randomBytes(32), body, now)},v1=${signWebhook(secret, body, now).split('v1=')[1]}`;
    expect(verify(both)).toEqual({ valid: true });
  });

  it('refuses missing and malformed headers', () => {
    expect(verify(undefined)).toEqual({ valid: false, reason: 'MISSING' });
    for (const header of ['garbage', 't=1', `v1=${'a'.repeat(64)}`, `t=abc,v1=${'a'.repeat(64)}`, `t=${now},v1=xyz`,
      `t=${now},t=${now},v1=${'a'.repeat(64)}`, `t=${now},=x`, 'x'.repeat(2000)]) {
      expect({ header: header.slice(0, 30), verdict: verify(header) }).toEqual({ header: header.slice(0, 30), verdict: { valid: false, reason: 'MALFORMED' } });
    }
    // Unknown schemes are ignored, never trusted.
    expect(verify(`t=${now},v0=${'a'.repeat(64)}`)).toEqual({ valid: false, reason: 'MALFORMED' });
  });
});

describe('webhook payload (only what we use)', () => {
  it('extracts the event id, type, payment id and reference; ignores everything else', () => {
    expect(parseWebhookHint(Buffer.from(JSON.stringify({
      id: 'evt_9', type: 'payment.captured', created: 'whenever', extra: [1, 2],
      data: { object: { id: 'pay_9', reference: 'ref-9', status: 'captured', amount: 1e21 } },
    })))).toEqual({ providerEventId: 'evt_9', eventType: 'payment.captured', paymentId: 'pay_9', reference: 'ref-9' });
    expect(parseWebhookHint(Buffer.from('{"id":"e","type":"t","data":{"object":{"id":"p"}}}'))?.reference).toBeNull();
    expect(extractProviderEventId(body)).toBe('evt_1');
  });

  it('refuses unusable bodies', () => {
    expect(parseWebhookHint(Buffer.from('not json'))).toBeUndefined();
    expect(parseWebhookHint(Buffer.from('{"id":"e","type":"t"}'))).toBeUndefined();
    expect(parseWebhookHint(Buffer.from('{"id":7,"type":"t","data":{"object":{"id":"p"}}}'))).toBeUndefined();
    expect(extractProviderEventId(Buffer.from('[]'))).toBeUndefined();
  });
});
