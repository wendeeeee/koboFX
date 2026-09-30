import { randomUUID } from 'node:crypto';
import { ValidationError } from '../../../common/errors';
import { InvalidCursorError } from '../../transactions/transactions.errors';
import { decodeAdminCursor, encodeAdminCursor, filterFingerprint, pageSizeOf, toPage } from './admin-cursor';

describe('admin keyset cursors', () => {
  const fingerprint = filterFingerprint('breaks', { status: 'LIVE', type: null });

  it('round-trips microseconds exactly (never through a Date) and is bound to its filters', () => {
    const position = { micros: 1_790_000_000_123_456n, id: randomUUID() };
    const cursor = encodeAdminCursor(position, fingerprint);
    expect(decodeAdminCursor(cursor, fingerprint)).toEqual(position);
    expect(() => decodeAdminCursor(cursor, filterFingerprint('breaks', { status: 'RESOLVED', type: null }))).toThrow(InvalidCursorError);
    expect(filterFingerprint('breaks', { b: null, a: true })).toBe(filterFingerprint('breaks', { a: true, b: null }));
  });

  it('refuses anything it did not mint', () => {
    for (const cursor of ['', '***', Buffer.from('{}').toString('base64url'), Buffer.from('not json').toString('base64url'), 'a'.repeat(300)]) {
      expect(() => decodeAdminCursor(cursor, fingerprint)).toThrow(InvalidCursorError);
    }
    const tampered = Buffer.from(JSON.stringify({ v: 1, t: '-1', i: randomUUID(), f: fingerprint })).toString('base64url');
    expect(() => decodeAdminCursor(tampered, fingerprint)).toThrow(InvalidCursorError);
  });

  it('limit: digits only, 1–100, default 50', () => {
    expect(pageSizeOf(undefined)).toBe(50);
    expect(pageSizeOf('100')).toBe(100);
    for (const limit of ['0', '101', '1e2', '-1', '']) expect(() => pageSizeOf(limit)).toThrow(ValidationError);
  });

  it('a next cursor only when a row beyond the page exists', () => {
    const rows = [1, 2, 3].map((n) => ({ item: n, position: { micros: BigInt(n), id: randomUUID() } }));
    expect(toPage(rows, 3, fingerprint).nextCursor).toBeNull();
    const page = toPage(rows, 2, fingerprint);
    expect(page.items).toEqual([1, 2]);
    expect(decodeAdminCursor(page.nextCursor!, fingerprint).micros).toBe(2n);
  });
});
