import { createHmac } from 'node:crypto';

/** Six ASCII digits. */
export const TRANSACTION_PIN_PATTERN = /^\d{6}$/;

/**
 * Why a PIN is too easy to guess, or null. Refused: all one digit (111111) and straight sequences up or down (123456,
 * 654321). Every other 6-digit PIN is allowed: the lock after a few wrong tries is what protects it.
 */
export function transactionPinWeakness(pin: string): string | null {
  if (!TRANSACTION_PIN_PATTERN.test(pin)) return 'must be exactly 6 digits';
  const digits = [...pin].map(Number);
  if (digits.every((digit) => digit === digits[0])) return 'must not be the same digit six times';
  const steps = digits.slice(1).map((digit, index) => digit - digits[index]);
  if (steps.every((step) => step === 1) || steps.every((step) => step === -1)) return 'must not be a straight sequence';
  return null;
}

/**
 * What argon2 hashes: an HMAC of the PIN bound to its owner, under the server-side pepper. Without the pepper a leaked
 * `pin_hash` cannot be tested against the million possible PINs; binding the user id makes every user's digest differ.
 */
export function transactionPinDigest(pepper: Buffer, userId: string, pin: string): string {
  return createHmac('sha256', pepper).update(`transaction-pin:v1:${userId}:${pin}`, 'utf8').digest('base64');
}
