import { createHash, createHmac } from 'node:crypto';
import { DependencyUnavailableError } from '../../errors';
import { KeyRing } from '../../crypto/key-ring';

/** JSON with object keys sorted at every depth: the same logical body always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The request hash (design §0.3 point 1): sha256 over the endpoint and the canonical
 * body, as lowercase hex. A reused key with a different body is refused (`409`) rather
 * than silently answered with a response to a different request.
 */
export function requestHash(endpoint: string, body: unknown): string {
  return createHash('sha256').update(endpoint).update('\n').update(canonicalJson(body)).digest('hex');
}

export enum RequestHashAlgorithm {
  SHA256_V1 = 'SHA256_V1',
  HMAC_SHA256_V1 = 'HMAC_SHA256_V1',
}

export interface RequestHashing {
  readonly algorithm: RequestHashAlgorithm;
  readonly keyId: string | null;
  readonly hash: string;
}

function ringOrUnavailable(ring: KeyRing | null): KeyRing {
  if (!ring) {
    throw new DependencyUnavailableError('This request needs IDEMPOTENCY_REQUEST_HASH_KEYS, which is not configured.', {
      dependency: 'request-hash-keys',
    });
  }
  return ring;
}

/** The hash a NEW key row gets: keyed (active key) when the route asks for it, SHA-256 otherwise. */
export function hashNewRequest(endpoint: string, body: unknown, keyed: boolean, ring: KeyRing | null): RequestHashing {
  if (!keyed) return { algorithm: RequestHashAlgorithm.SHA256_V1, keyId: null, hash: requestHash(endpoint, body) };
  const keys = ringOrUnavailable(ring);
  return hashWith(endpoint, body, RequestHashAlgorithm.HMAC_SHA256_V1, keys.activeKeyId, keys);
}

/**
 * The hash to compare against an EXISTING row: that row's own algorithm and key, whatever the route or active key is
 * now. A key that has left the ring makes the request fail transiently (no answer is better than a wrong one).
 */
export function hashWith(endpoint: string, body: unknown, algorithm: RequestHashAlgorithm, keyId: string | null, ring: KeyRing | null): RequestHashing {
  if (algorithm === RequestHashAlgorithm.SHA256_V1) return { algorithm, keyId: null, hash: requestHash(endpoint, body) };
  const key = keyId === null ? undefined : ringOrUnavailable(ring).keys.get(keyId);
  if (!key) {
    throw new DependencyUnavailableError('A stored idempotency key was hashed with a key that is no longer configured.', {
      dependency: 'request-hash-keys',
      keyId,
    });
  }
  return { algorithm, keyId, hash: createHmac('sha256', key).update(endpoint).update('\n').update(canonicalJson(body)).digest('hex') };
}
