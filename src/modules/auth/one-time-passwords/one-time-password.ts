import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export enum OneTimePasswordPurpose {
  VERIFY_EMAIL = 'VERIFY_EMAIL',
}

export const ONE_TIME_PASSWORD_DIGITS = 6;
export const ONE_TIME_PASSWORD_TIME_TO_LIVE_SECONDS = 10 * 60;
export const ONE_TIME_PASSWORD_MAXIMUM_ATTEMPTS = 5;

const UPPER_BOUND = 10 ** ONE_TIME_PASSWORD_DIGITS;
const FORMAT = /^\d{6}$/;


export function generateOneTimePassword(): string {
  return randomInt(0, UPPER_BOUND).toString().padStart(ONE_TIME_PASSWORD_DIGITS, '0');
}


export function hashOneTimePassword(pepper: Buffer, challengeId: string, code: string): Buffer {
  return createHmac('sha256', pepper).update(`${challengeId}:${code}`, 'utf8').digest();
}

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
