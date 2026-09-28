import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/** What a one-time password is for. Mirrors the `one_time_password_purpose` enum. */
export enum OneTimePasswordPurpose {
  VERIFY_EMAIL = 'VERIFY_EMAIL',
}

export const ONE_TIME_PASSWORD_DIGITS = 6;
/** design §7.1: 10-minute TTL, at most 5 attempts. */
export const ONE_TIME_PASSWORD_TIME_TO_LIVE_SECONDS = 10 * 60;
export const ONE_TIME_PASSWORD_MAXIMUM_ATTEMPTS = 5;

const UPPER_BOUND = 10 ** ONE_TIME_PASSWORD_DIGITS;
const FORMAT = /^\d{6}$/;

/**
 * Six uniformly distributed digits from the CSPRNG. `crypto.randomInt` rejects
 * out-of-range samples internally, so there is no modulo bias (unlike `byte % 10`).
 */
export function generateOneTimePassword(): string {
  return randomInt(0, UPPER_BOUND).toString().padStart(ONE_TIME_PASSWORD_DIGITS, '0');
}

/**
 * HMAC-SHA256 under the server-side pepper (design §7.1). The challenge id is part of
 * the input, so a stored HMAC is bound to its challenge: it can't be moved to another
 * user or another issuance.
 */
export function hashOneTimePassword(pepper: Buffer, challengeId: string, code: string): Buffer {
  return createHmac('sha256', pepper).update(`${challengeId}:${code}`, 'utf8').digest();
}

/** Constant-time comparison of a candidate against the stored HMAC. */
export function oneTimePasswordMatches(
  pepper: Buffer,
  challengeId: string,
  candidate: string,
  expectedHmac: Buffer,
): boolean {
  if (!FORMAT.test(candidate)) return false;
  const actual = hashOneTimePassword(pepper, challengeId, candidate);
  return actual.length === expectedHmac.length && timingSafeEqual(actual, expectedHmac);
}
