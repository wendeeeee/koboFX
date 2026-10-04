import { randomBytes } from 'node:crypto';
import { KeyRing } from '../../crypto/key-ring';
import { RequestHashAlgorithm, hashNewRequest, hashWith, requestHash } from './request-hash';

describe('versioned request hashes (WITHDRAWAL_PLAN.md §H)', () => {
  const ring: KeyRing = { activeKeyId: 'rh-2', keys: new Map([['rh-1', randomBytes(32)], ['rh-2', randomBytes(32)]]) };
  const endpoint = 'POST /wallet/withdrawal-beneficiaries';
  const body = { bankCode: '058', accountNumber: '0123456789', currency: 'NGN' };

  it('unkeyed routes keep the plain SHA-256 (every existing row stays valid)', () => {
    expect(hashNewRequest(endpoint, body, false, null)).toEqual({ algorithm: RequestHashAlgorithm.SHA256_V1, keyId: null, hash: requestHash(endpoint, body) });
  });

  it('keyed routes use the active key; the hash is not the plain SHA-256 and differs per key', () => {
    const keyed = hashNewRequest(endpoint, body, true, ring);
    expect(keyed.algorithm).toBe(RequestHashAlgorithm.HMAC_SHA256_V1);
    expect(keyed.keyId).toBe('rh-2');
    expect(keyed.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(keyed.hash).not.toBe(requestHash(endpoint, body));
    expect(hashWith(endpoint, body, RequestHashAlgorithm.HMAC_SHA256_V1, 'rh-1', ring).hash).not.toBe(keyed.hash);
  });

  it('a stored row is re-checked with ITS key after rotation; key order in the body does not matter', () => {
    const stored = hashWith(endpoint, body, RequestHashAlgorithm.HMAC_SHA256_V1, 'rh-1', ring);
    const reordered = { currency: 'NGN', accountNumber: '0123456789', bankCode: '058' };
    expect(hashWith(endpoint, reordered, RequestHashAlgorithm.HMAC_SHA256_V1, 'rh-1', ring).hash).toBe(stored.hash);
    expect(hashWith(endpoint, { ...body, accountNumber: '0123456780' }, RequestHashAlgorithm.HMAC_SHA256_V1, 'rh-1', ring).hash).not.toBe(stored.hash);
  });

  it('fails as a dependency problem — never falls back to an unkeyed hash', () => {
    expect(() => hashNewRequest(endpoint, body, true, null)).toThrow(expect.objectContaining({ code: 'DEPENDENCY_UNAVAILABLE' }));
    expect(() => hashWith(endpoint, body, RequestHashAlgorithm.HMAC_SHA256_V1, 'retired', ring)).toThrow(
      expect.objectContaining({ code: 'DEPENDENCY_UNAVAILABLE' }),
    );
  });
});
