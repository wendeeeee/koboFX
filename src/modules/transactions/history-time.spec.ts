import fc from 'fast-check';
import { ErrorCode } from '../../common/errors';
import { microsecondsToTimestamp, parseInstantMicroseconds, timestampToMicroseconds } from './history-time';

const refused = (text: string) => {
  try {
    parseInstantMicroseconds('from', text);
    return 'accepted';
  } catch (error) {
    expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect((error as { details: { violations: string[] } }).details.violations[0]).toMatch(/^from /);
    return 'refused';
  }
};

describe('history instants (epoch microseconds, never through a Date)', () => {
  it('parses whole seconds, fractions to 6 digits, and offsets exactly', () => {
    expect(parseInstantMicroseconds('from', '1970-01-01T00:00:00Z')).toBe(0n);
    expect(parseInstantMicroseconds('from', '2026-09-29T10:00:00.123456Z')).toBe(BigInt(Date.UTC(2026, 8, 29, 10)) * 1000n + 123_456n);
    expect(parseInstantMicroseconds('from', '2026-09-29T10:00:00.1Z')).toBe(BigInt(Date.UTC(2026, 8, 29, 10)) * 1000n + 100_000n);
    expect(parseInstantMicroseconds('from', '2026-09-29T11:30:00+01:30')).toBe(BigInt(Date.UTC(2026, 8, 29, 10)) * 1000n);
    expect(parseInstantMicroseconds('from', '2026-09-29T05:00:00-05:00')).toBe(BigInt(Date.UTC(2026, 8, 29, 10)) * 1000n);
  });

  it('agrees with Date on millisecond instants in any offset', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('1970-01-02T00:00:00Z'), max: new Date('9998-12-31T00:00:00Z'), noInvalidDate: true }), (date) => {
        expect(parseInstantMicroseconds('from', date.toISOString())).toBe(BigInt(date.getTime()) * 1000n);
      }),
    );
  });

  it.each([
    '2026-09-29',
    '2026-09-29T10:00:00',
    '2026-09-29 10:00:00Z',
    '2026-09-29T10:00:00.1234567Z',
    '2026-02-30T10:00:00Z',
    '2026-13-01T10:00:00Z',
    '2026-09-29T24:00:00Z',
    '2026-09-29T10:60:00Z',
    '2026-09-29T10:00:61Z',
    '2026-09-29T10:00:00+19:00',
    '2026-09-29T10:00:00+05:60',
    '1969-12-31T23:59:59Z',
    '+02026-09-29T10:00:00Z',
    '2026-09-29T10:00:00z',
  ])('refuses %s', (text) => {
    expect(refused(text)).toBe('refused');
  });

  it('leap days exist only in leap years', () => {
    expect(refused('2024-02-29T00:00:00Z')).toBe('accepted');
    expect(refused('2026-02-29T00:00:00Z')).toBe('refused');
  });

  it('builds the exact SQL conversions', () => {
    expect(microsecondsToTimestamp('$3')).toBe(`(timestamptz 'epoch' + $3::bigint * interval '1 microsecond')`);
    expect(timestampToMicroseconds('t.value_time')).toBe('(extract(epoch FROM t.value_time) * 1000000)::bigint::text');
  });
});
