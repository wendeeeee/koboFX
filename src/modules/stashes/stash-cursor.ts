import { InvalidCursorError } from '../transactions/transactions.errors';

/** A position in a stash's receipts: `recorded_at` in epoch microseconds (exact; never through a JS `Date`) + the id. */
export interface StashPosition {
  readonly timeMicroseconds: bigint;
  readonly id: string;
}

export const STASH_CURSOR_VERSION = 1;
export const MAXIMUM_STASH_CURSOR_LENGTH = 256;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MICROSECONDS_PATTERN = /^(0|[1-9]\d{0,17})$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

interface CursorPayload {
  readonly v: number;
  readonly t: string;
  readonly i: string;
  /** The currency filter the cursor was issued under (null = none): another filter is a different traversal. */
  readonly c: string | null;
}

export function encodeStashCursor(position: StashPosition, currency: string | null): string {
  const payload: CursorPayload = { v: STASH_CURSOR_VERSION, t: position.timeMicroseconds.toString(), i: position.id, c: currency };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Validated, not signed: it only narrows rows already scoped to the caller in SQL. Anything else is `INVALID_CURSOR`. */
export function decodeStashCursor(cursor: string, currency: string | null): StashPosition {
  if (cursor.length === 0 || cursor.length > MAXIMUM_STASH_CURSOR_LENGTH) throw new InvalidCursorError('length');
  if (!BASE64URL_PATTERN.test(cursor)) throw new InvalidCursorError('encoding');
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('encoding');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || Object.keys(payload).length !== 4) {
    throw new InvalidCursorError('shape');
  }
  const { v, t, i, c } = payload as Partial<Record<keyof CursorPayload, unknown>>;
  if (v !== STASH_CURSOR_VERSION) throw new InvalidCursorError('version');
  if (typeof t !== 'string' || !MICROSECONDS_PATTERN.test(t)) throw new InvalidCursorError('position');
  if (typeof i !== 'string' || !UUID_PATTERN.test(i)) throw new InvalidCursorError('position');
  if (c !== currency) throw new InvalidCursorError('query');
  return { timeMicroseconds: BigInt(t), id: i };
}
