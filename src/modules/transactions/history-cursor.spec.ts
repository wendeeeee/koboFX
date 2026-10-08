import fc from 'fast-check';
import { ErrorCode } from '../../common/errors';
import { CURSOR_VERSION, HistoryQuery, HistorySort, decodeCursor, encodeCursor, queryFingerprint } from './history-cursor';

const BASE: HistoryQuery = { sort: HistorySort.VALUE_TIME, type: null, currency: null, fromMicroseconds: null, toMicroseconds: null };
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const raw = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
const valid = (query: HistoryQuery = BASE) => ({ v: CURSOR_VERSION, s: query.sort === HistorySort.VALUE_TIME ? 'V' : 'B', t: '1790000000123456', i: ID, f: queryFingerprint(query) });

function reasonOf(cursor: string, query: HistoryQuery = BASE): unknown {
  try {
    decodeCursor(cursor, query);
    return 'accepted';
  } catch (error) {
    const { code, details } = error as { code: ErrorCode; details: { reason: string } };
    expect(code).toBe(ErrorCode.INVALID_CURSOR);
    return details.reason;
  }
}

describe('history cursor', () => {
  it('round-trips (time, id) at microsecond precision, for any query', () => {
    const query = fc.record({
      sort: fc.constantFrom(HistorySort.VALUE_TIME, HistorySort.BOOKING_TIME),
      type: fc.option(fc.constantFrom('FUNDING', 'CONVERSION', 'REVERSAL'), { nil: null }),
      currency: fc.option(fc.constantFrom('NGN', 'USD', 'JPY'), { nil: null }),
      fromMicroseconds: fc.option(fc.bigInt({ min: 0n, max: 253_402_300_799_999_999n }), { nil: null }),
      toMicroseconds: fc.option(fc.bigInt({ min: 0n, max: 253_402_300_799_999_999n }), { nil: null }),
    });
    fc.assert(
      fc.property(query, fc.bigInt({ min: 0n, max: 253_402_300_799_999_999n }), fc.uuid({ version: 4 }), (history, timeMicroseconds, id) => {
        const cursor = encodeCursor({ timeMicroseconds, id }, history);
        expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(cursor.length).toBeLessThanOrEqual(256);
        expect(decodeCursor(cursor, history)).toEqual({ timeMicroseconds, id });
      }),
    );
  });

  it('keeps two positions one microsecond apart distinct', () => {
    const a = encodeCursor({ timeMicroseconds: 1_790_000_000_000_001n, id: ID }, BASE);
    const b = encodeCursor({ timeMicroseconds: 1_790_000_000_000_002n, id: ID }, BASE);
    expect(a).not.toBe(b);
    expect(decodeCursor(a, BASE).timeMicroseconds).toBe(1_790_000_000_000_001n);
  });

  it('is bound to its query: another sort or any other filter is refused (limit is not part of it)', () => {
    const cursor = encodeCursor({ timeMicroseconds: 1n, id: ID }, BASE);
    const others: HistoryQuery[] = [
      { ...BASE, sort: HistorySort.BOOKING_TIME },
      { ...BASE, type: 'FUNDING' },
      { ...BASE, currency: 'NGN' },
      { ...BASE, fromMicroseconds: 0n },
      { ...BASE, toMicroseconds: 1n },
    ];
    for (const other of others) expect(reasonOf(cursor, other)).toMatch(/^(query|sort)$/);
    expect(new Set(others.map(queryFingerprint)).size).toBe(others.length);
    expect(others.map(queryFingerprint)).not.toContain(queryFingerprint(BASE));
  });

  it.each([
    ['empty', '', 'length'],
    ['too long', 'A'.repeat(257), 'length'],
    ['not base64url', 'abc+/=', 'encoding'],
    ['not JSON', Buffer.from('nope').toString('base64url'), 'encoding'],
    ['an array', raw([1, 2]), 'shape'],
    ['null', raw(null), 'shape'],
    ['a number', raw(5), 'shape'],
    ['a missing field', raw({ v: 1, s: 'V', t: '1', i: ID }), 'shape'],
    ['an extra field', raw({ ...valid(), x: 1 }), 'shape'],
    ['another version', raw({ ...valid(), v: 2 }), 'version'],
    ['a version as a string', raw({ ...valid(), v: '1' }), 'version'],
    ['an unknown sort', raw({ ...valid(), s: 'X' }), 'sort'],
    ['a time with a fraction', raw({ ...valid(), t: '1.5' }), 'position'],
    ['a time as a number', raw({ ...valid(), t: 1 }), 'position'],
    ['a time with leading zeros', raw({ ...valid(), t: '0012' }), 'position'],
    ['a time out of range', raw({ ...valid(), t: '999999999999999999' }), 'position'],
    ['a negative time out of range', raw({ ...valid(), t: '-999999999999999999' }), 'position'],
    ['an id that is not a UUID', raw({ ...valid(), i: 'x' }), 'position'],
    ['an uppercase id', raw({ ...valid(), i: ID.toUpperCase() }), 'position'],
    ['another fingerprint', raw({ ...valid(), f: '0000000000000000' }), 'query'],
    ['the other sort', raw({ ...valid(), s: 'B' }), 'query'],
  ])('refuses %s with INVALID_CURSOR', (_label, cursor, reason) => {
    expect(reasonOf(cursor)).toBe(reason);
  });

  it('accepts a well-formed cursor, including a negative (pre-1970) time', () => {
    expect(reasonOf(raw(valid()))).toBe('accepted');
    expect(reasonOf(raw({ ...valid(), t: '-5' }))).toBe('accepted');
    expect(reasonOf(raw({ ...valid(), t: '0' }))).toBe('accepted');
  });
});
