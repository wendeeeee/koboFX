import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook authenticity (design §7.3, handbook: verify the caller).
 *
 * Header `X-Psp-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>`; the signed material
 * is `${t}.` followed by the RAW request bytes — never a re-serialised payload, which
 * changes bytes and breaks (or worse, forges) the signature. The timestamp is inside
 * the MAC, and a delivery older or newer than the tolerance is refused, which bounds
 * replay. Several `v1` values and up to two secrets are accepted, so the PSP and we can
 * rotate the secret without dropping webhooks.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'x-psp-signature';

export type SignatureVerdict =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: 'MISSING' | 'MALFORMED' | 'STALE' | 'MISMATCH' };

const MAXIMUM_HEADER_LENGTH = 1024;
const HEX_DIGEST = /^[0-9a-f]{64}$/;

function mac(secret: Buffer, timestampSeconds: string, rawBody: Buffer): Buffer {
  return createHmac('sha256', secret).update(`${timestampSeconds}.`).update(rawBody).digest();
}

/** How the PSP (and our tests) sign a delivery. */
export function signWebhook(secret: Buffer, rawBody: Buffer, timestampSeconds: number): string {
  return `t=${timestampSeconds},v1=${mac(secret, String(timestampSeconds), rawBody).toString('hex')}`;
}

export function verifyWebhookSignature(
  header: string | undefined,
  rawBody: Buffer,
  secrets: readonly Buffer[],
  nowSeconds: number,
  toleranceSeconds: number,
): SignatureVerdict {
  if (!header) return { valid: false, reason: 'MISSING' };
  if (header.length > MAXIMUM_HEADER_LENGTH) return { valid: false, reason: 'MALFORMED' };
  let timestamp: string | undefined;
  const signatures: Buffer[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0) return { valid: false, reason: 'MALFORMED' };
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === 't') {
      if (timestamp !== undefined || !/^\d{1,12}$/.test(value)) return { valid: false, reason: 'MALFORMED' };
      timestamp = value;
    } else if (name === 'v1') {
      if (!HEX_DIGEST.test(value)) return { valid: false, reason: 'MALFORMED' };
      signatures.push(Buffer.from(value, 'hex'));
    }
    // Other schemes (v0, future versions) are ignored, never trusted.
  }
  if (timestamp === undefined || signatures.length === 0) return { valid: false, reason: 'MALFORMED' };
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return { valid: false, reason: 'STALE' };

  let matched = false;
  for (const secret of secrets) {
    const expected = mac(secret, timestamp, rawBody);
    // Compare against every candidate without short-circuiting on the first match.
    for (const signature of signatures) {
      if (timingSafeEqual(expected, signature)) matched = true;
    }
  }
  return matched ? { valid: true } : { valid: false, reason: 'MISMATCH' };
}
