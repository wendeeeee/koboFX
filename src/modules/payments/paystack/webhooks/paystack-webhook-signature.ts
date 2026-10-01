import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Paystack webhook authenticity (PAYSTACK_PLAN.md A6): header `x-paystack-signature` = hex HMAC-SHA512 of the RAW
 * request body, keyed with the secret key. No timestamp: a replay is harmless here because processing only TRIGGERS a
 * verify and the posting is idempotent by reference (C4). Verified over the exact bytes received, never a
 * re-serialised payload, and compared in constant time.
 */
export const PAYSTACK_SIGNATURE_HEADER = 'x-paystack-signature';

export type PaystackSignatureVerdict =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: 'MISSING' | 'MALFORMED' | 'MISMATCH' };

const HEX_SHA512 = /^[0-9a-f]{128}$/i;

/** How Paystack (and our mock and tests) sign a delivery. */
export function signPaystackWebhook(secretKey: string, rawBody: Buffer): string {
  return createHmac('sha512', secretKey).update(rawBody).digest('hex');
}

export function verifyPaystackSignature(header: string | undefined, rawBody: Buffer, secretKey: string): PaystackSignatureVerdict {
  if (header === undefined || header.length === 0) return { valid: false, reason: 'MISSING' };
  if (!HEX_SHA512.test(header)) return { valid: false, reason: 'MALFORMED' };
  if (secretKey.length === 0) return { valid: false, reason: 'MISMATCH' };
  const expected = createHmac('sha512', secretKey).update(rawBody).digest();
  // Same length by construction (128 hex chars = 64 bytes): timingSafeEqual never throws here.
  return timingSafeEqual(expected, Buffer.from(header, 'hex')) ? { valid: true } : { valid: false, reason: 'MISMATCH' };
}
