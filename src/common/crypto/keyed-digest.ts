import { createHmac, timingSafeEqual } from 'node:crypto';
import { InvariantViolationError } from '../errors';
import { KeyRing } from './key-ring';

/**
 * Keyed digests (WITHDRAWAL_PLAN.md §H): HMAC-SHA256 over a length-prefixed canonical encoding of the parts, so
 * `["ab","c"]` and `["a","bc"]` never collide and nobody without the key can enumerate (say) account numbers by
 * hashing guesses. Used for destination fingerprints (owner, bank, full number, type, currency) and for the request
 * hash of idempotent requests whose body carries PII.
 */
export interface KeyedDigest {
  readonly keyId: string;
  readonly digest: Buffer;
}

export function canonicalParts(domain: string, parts: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of [domain, ...parts]) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}

export function keyedDigest(ring: KeyRing, domain: string, parts: readonly string[], keyId = ring.activeKeyId): KeyedDigest {
  const key = ring.keys.get(keyId);
  if (!key) throw new InvariantViolationError('No such key in the ring.', { keyId });
  return { keyId, digest: createHmac('sha256', key).update(canonicalParts(domain, parts)).digest() };
}

/**
 * The digest under EVERY key in the ring, active first: a lookup during key rotation searches all of them, so the same
 * account is found (not silently duplicated) whichever key fingerprinted it. Equality is only a lookup aid; callers
 * compare the decrypted identity before acting.
 */
export function keyedDigestCandidates(ring: KeyRing, domain: string, parts: readonly string[]): KeyedDigest[] {
  const ids = [ring.activeKeyId, ...[...ring.keys.keys()].filter((id) => id !== ring.activeKeyId).sort()];
  return ids.map((keyId) => keyedDigest(ring, domain, parts, keyId));
}

export function digestsEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
