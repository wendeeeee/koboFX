import { createHash } from 'node:crypto';
import { InvalidCursorError } from './transactions.errors';

/** Which time a history is ordered (and range-filtered) by (design §7.8). */
export enum HistorySort {
  /** When it happened: the default, what the user and the business mean by "when". */
  VALUE_TIME = 'valueTime',
  /** When we recorded it: support, traceability, and "never miss a row" consumers. */
  BOOKING_TIME = 'bookingTime',
}

/** The normalised query a cursor belongs to. Two queries are "the same" iff these are equal. */
export interface HistoryQuery {
  readonly sort: HistorySort;
  readonly type: string | null;
  readonly currency: string | null;
  /** Inclusive lower bound on the sort's time, epoch µs. */
  readonly fromMicroseconds: bigint | null;
  /** Exclusive upper bound on the sort's time, epoch µs. */
  readonly toMicroseconds: bigint | null;
}

/** A keyset position: the last row of a page, `(time, id)` in the query's sort. */
export interface HistoryPosition {
  readonly timeMicroseconds: bigint;
  readonly id: string;
}

export const CURSOR_VERSION = 1;
export const MAXIMUM_CURSOR_LENGTH = 256;

const SORT_CODES: Readonly<Record<HistorySort, string>> = { [HistorySort.VALUE_TIME]: 'V', [HistorySort.BOOKING_TIME]: 'B' };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MICROSECONDS_PATTERN = /^(0|-?[1-9]\d{0,17})$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Postgres TIMESTAMPTZ spans 4713 BC … 294276 AD; history times are far inside ±(year 9999). */
const MAXIMUM_ABSOLUTE_MICROSECONDS = 253_402_300_800_000_000n;

interface CursorPayload {
  readonly v: number;
  readonly s: string;
  readonly t: string;
  readonly i: string;
  readonly f: string;
}

/**
 * A fingerprint of everything but the position: a cursor presented with another sort or other
 * filters would silently skip or repeat rows, so it is refused instead. `limit` is not part of it
 * (a client may change page size between pages).
 */
export function queryFingerprint(query: HistoryQuery): string {
  const canonical = JSON.stringify([
    SORT_CODES[query.sort],
    query.type,
    query.currency,
    query.fromMicroseconds?.toString() ?? null,
    query.toMicroseconds?.toString() ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Opaque to clients: base64url of canonical JSON `{v, s, t, i, f}`. Validated, not signed (Phase 8
 * decision 6): it only ever narrows rows already scoped to the caller in SQL.
 */
export function encodeCursor(position: HistoryPosition, query: HistoryQuery): string {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    s: SORT_CODES[query.sort],
    t: position.timeMicroseconds.toString(),
    i: position.id,
    f: queryFingerprint(query),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** The position a cursor encodes, if — and only if — it was minted for this very query. */
export function decodeCursor(cursor: string, query: HistoryQuery): HistoryPosition {
  if (cursor.length === 0 || cursor.length > MAXIMUM_CURSOR_LENGTH) throw new InvalidCursorError('length');
  if (!BASE64URL_PATTERN.test(cursor)) throw new InvalidCursorError('encoding');
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('encoding');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new InvalidCursorError('shape');
  const { v, s, t, i, f } = payload as Partial<Record<keyof CursorPayload, unknown>>;
  if (Object.keys(payload).length !== 5) throw new InvalidCursorError('shape');
  if (v !== CURSOR_VERSION) throw new InvalidCursorError('version');
  if (typeof s !== 'string' || !Object.values(SORT_CODES).includes(s)) throw new InvalidCursorError('sort');
  if (typeof t !== 'string' || !MICROSECONDS_PATTERN.test(t)) throw new InvalidCursorError('position');
  const timeMicroseconds = BigInt(t);
  if (timeMicroseconds > MAXIMUM_ABSOLUTE_MICROSECONDS || -timeMicroseconds > MAXIMUM_ABSOLUTE_MICROSECONDS) {
    throw new InvalidCursorError('position');
  }
  if (typeof i !== 'string' || !UUID_PATTERN.test(i)) throw new InvalidCursorError('position');
  if (s !== SORT_CODES[query.sort] || f !== queryFingerprint(query)) throw new InvalidCursorError('query');
  return { timeMicroseconds, id: i };
}
