import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { InvariantViolationError } from '../errors';

/**
 * The sealing codec (WITHDRAWAL_PLAN.md §H; D6): AES-256-GCM with a random 96-bit nonce and a 128-bit tag.
 *
 *   sealed = version (1 byte, 0x01) ‖ nonce (12) ‖ ciphertext ‖ tag (16)
 *
 * The additional authenticated data names WHERE the bytes belong (table, column, row, owner, provider, codec), so a
 * sealed value copied to another row, column or owner fails to open instead of decrypting in the wrong place. Opening
 * never falls back to anything: a wrong key, a tampered byte or the wrong context throws.
 */
export const SEALING_CODEC_VERSION = 1;
const VERSION_BYTE = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const SEALED_OVERHEAD_BYTES = 1 + NONCE_BYTES + TAG_BYTES;
const KEY_BYTES = 32;

export class SealedValueRejectedError extends InvariantViolationError {}

/** Where a sealed value lives; becomes the AAD. Every part is plain text without `|`. */
export interface SealingContext {
  readonly table: string;
  readonly column: string;
  readonly rowId: string;
  readonly ownerId?: string | null;
  readonly provider?: string | null;
}

export function contextBytes(context: SealingContext): Buffer {
  const parts = [`v${SEALING_CODEC_VERSION}`, context.table, context.column, context.rowId, context.ownerId ?? '-', context.provider ?? '-'];
  for (const part of parts) {
    if (part.length === 0 || part.includes('|')) {
      throw new InvariantViolationError('A sealing context part must be non-empty and free of "|".', { part });
    }
  }
  return Buffer.from(parts.join('|'), 'utf8');
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new InvariantViolationError('A sealing key is exactly 32 bytes.', { length: key.length });
}

export function seal(key: Buffer, plaintext: Buffer, context: SealingContext): Buffer {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(contextBytes(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION_BYTE]), nonce, ciphertext, cipher.getAuthTag()]);
}

export function open(key: Buffer, sealed: Buffer, context: SealingContext): Buffer {
  assertKey(key);
  if (sealed.length < SEALED_OVERHEAD_BYTES || sealed[0] !== VERSION_BYTE) {
    throw new SealedValueRejectedError('Not a sealed value of a known codec version.', { length: sealed.length });
  }
  const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const ciphertext = sealed.subarray(1 + NONCE_BYTES, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(contextBytes(context));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new SealedValueRejectedError('A sealed value failed authentication (wrong key, context or tampered bytes).', {
      table: context.table,
      column: context.column,
      rowId: context.rowId,
    });
  }
}
