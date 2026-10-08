import { isLosslessNumber, parse } from 'lossless-json';

/**
 * Which family a Paystack event belongs to, decided from the event NAME before any identifier is looked up
 * (WITHDRAWAL_PLAN.md §I.1): a transfer id is never searched among funding transactions, nor a charge id among
 * withdrawals — the two id spaces may collide. Unknown families stay preserved and unmatched; nothing is guessed.
 */
export enum PaystackEventFamily {
  CHARGE = 'CHARGE',
  TRANSFER = 'TRANSFER',
  UNKNOWN = 'UNKNOWN',
}

/** The transfer events a withdrawal acts on (as hints; verify is the fact). */
export const SUPPORTED_TRANSFER_EVENTS: readonly string[] = ['transfer.success', 'transfer.failed', 'transfer.reversed'];

export interface PaystackTransferHint {
  readonly eventType: string;
  readonly transferId: string | null;
  readonly transferCode: string | null;
  readonly reference: string | null;
}

export function familyOfEvent(eventType: string): PaystackEventFamily {
  if (eventType.startsWith('charge.')) return PaystackEventFamily.CHARGE;
  if (SUPPORTED_TRANSFER_EVENTS.includes(eventType)) return PaystackEventFamily.TRANSFER;
  return PaystackEventFamily.UNKNOWN;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isLosslessNumber(value) ? (value as Record<string, unknown>) : null;
}

/** The event name of a raw payload, or null when it is not a JSON object with a string `event`. */
export function eventTypeOf(rawPayload: Buffer): string | null {
  try {
    const event = objectOf(parse(rawPayload.toString('utf8')))?.event;
    return typeof event === 'string' && event.length > 0 && event.length <= 64 ? event : null;
  } catch {
    return null;
  }
}

/** Ids of a supported transfer event: transfer id, transfer code and OUR reference. Amounts are never read. */
export function parseTransferHint(rawPayload: Buffer): PaystackTransferHint | null {
  let json: unknown;
  try {
    json = parse(rawPayload.toString('utf8'));
  } catch {
    return null;
  }
  const body = objectOf(json);
  const eventType = typeof body?.event === 'string' ? body.event : null;
  const data = objectOf(body?.data);
  if (!eventType || familyOfEvent(eventType) !== PaystackEventFamily.TRANSFER || !data) return null;
  const id = isLosslessNumber(data.id) ? data.id.value : typeof data.id === 'string' ? data.id : null;
  const code = typeof data.transfer_code === 'string' && /^TRF_[A-Za-z0-9]{1,64}$/.test(data.transfer_code) ? data.transfer_code : null;
  const reference = typeof data.reference === 'string' && data.reference.length <= 100 ? data.reference : null;
  return { eventType, transferId: id && /^[1-9]\d{0,29}$/.test(id) ? id : null, transferCode: code, reference };
}
