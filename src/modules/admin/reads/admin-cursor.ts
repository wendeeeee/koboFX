import { createHash } from 'node:crypto';
import { ValidationError } from '../../../common/errors';
import { InvalidCursorError } from '../../transactions/transactions.errors';

/**
 * Keyset cursors for the admin lists (approvals, breaks, runs): newest first on `(time, id)`. Same rules as
 * history's (Phase 8 decision 6): base64url of canonical JSON, the time in epoch MICROSECONDS (never through a
 * JS `Date`), a fingerprint of the filters so a cursor cannot be replayed under other filters. Validated, not
 * signed — it only narrows rows the route already scopes (ADMIN-only lists).
 */
export interface AdminPosition {
  readonly micros: bigint;
  readonly id: string;
}

const VERSION = 1;
const MAXIMUM_LENGTH = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGITS = /^(0|[1-9]\d{0,18})$/;

export const DEFAULT_ADMIN_PAGE_SIZE = 50;
export const MAXIMUM_ADMIN_PAGE_SIZE = 100;

export function filterFingerprint(list: string, filters: Readonly<Record<string, string | boolean | null>>): string {
  const canonical = JSON.stringify([list, ...Object.keys(filters).sort().map((key) => [key, filters[key]])]);
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 16);
}

export function encodeAdminCursor(position: AdminPosition, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ v: VERSION, t: position.micros.toString(), i: position.id, f: fingerprint })).toString('base64url');
}

export function decodeAdminCursor(cursor: string, fingerprint: string): AdminPosition {
  if (cursor.length === 0 || cursor.length > MAXIMUM_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCursorError('MALFORMED');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('MALFORMED');
  }
  const candidate = parsed as { v?: unknown; t?: unknown; i?: unknown; f?: unknown };
  if (typeof parsed !== 'object' || parsed === null || candidate.v !== VERSION) throw new InvalidCursorError('UNKNOWN_VERSION');
  if (typeof candidate.t !== 'string' || !DIGITS.test(candidate.t) || typeof candidate.i !== 'string' || !UUID.test(candidate.i)) {
    throw new InvalidCursorError('MALFORMED');
  }
  if (candidate.f !== fingerprint) throw new InvalidCursorError('DIFFERENT_QUERY');
  return { micros: BigInt(candidate.t), id: candidate.i };
}

/** `limit` query parameter: digits only, 1–100, default 50. */
export function pageSizeOf(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_ADMIN_PAGE_SIZE;
  if (!/^[1-9]\d{0,2}$/.test(raw) || Number.parseInt(raw, 10) > MAXIMUM_ADMIN_PAGE_SIZE) {
    throw new ValidationError('limit must be a whole number from 1 to 100.', { limit: raw });
  }
  return Number.parseInt(raw, 10);
}

export interface AdminPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** Fetch `limit + 1` rows; the extra one says whether there is a next page. */
export function toPage<T>(rows: readonly { item: T; position: AdminPosition }[], limit: number, fingerprint: string): AdminPage<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items: items.map((row) => row.item),
    nextCursor: rows.length > limit && last ? encodeAdminCursor(last.position, fingerprint) : null,
  };
}
