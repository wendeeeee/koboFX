import { createHash } from 'node:crypto';
import { InvalidCursorError } from './transactions.errors';

export enum HistorySort {
  VALUE_TIME = 'valueTime',
  BOOKING_TIME = 'bookingTime',
}

export interface HistoryQuery {
  readonly sort: HistorySort;
  readonly type: string | null;
  readonly currency: string | null;
  readonly fromMicroseconds: bigint | null;
  readonly toMicroseconds: bigint | null;
}

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
const MAXIMUM_ABSOLUTE_MICROSECONDS = 253_402_300_800_000_000n;

interface CursorPayload {
  readonly v: number;
  readonly s: string;
  readonly t: string;
  readonly i: string;
  readonly f: string;
}


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
