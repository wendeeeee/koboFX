import { ValidationError } from '../../common/errors';


export const ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;

const MINIMUM_YEAR = 1970;
const MAXIMUM_YEAR = 9999;

export function parseInstantMicroseconds(field: string, text: string): bigint {
  const match = ISO_INSTANT_PATTERN.exec(text);
  if (!match) throw invalid(field, 'must be ISO-8601 with an offset, e.g. 2026-09-29T10:00:00Z');
  const [, year, month, day, hour, minute, second, fraction = '', offset] = match;
  const fields = [year, month, day, hour, minute, second].map(Number);
  const [y, mo, d, h, mi, s] = fields;
  if (y < MINIMUM_YEAR || y > MAXIMUM_YEAR) throw invalid(field, `year must be between ${MINIMUM_YEAR} and ${MAXIMUM_YEAR}`);
  const localMilliseconds = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(localMilliseconds);
  if (
    check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d ||
    check.getUTCHours() !== h || check.getUTCMinutes() !== mi || check.getUTCSeconds() !== s
  ) {
    throw invalid(field, 'is not a real calendar instant');
  }
  let offsetMinutes = 0;
  if (offset !== 'Z') {
    const offsetHours = Number(offset.slice(1, 3));
    const offsetRest = Number(offset.slice(4, 6));
    if (offsetHours > 18 || offsetRest > 59) throw invalid(field, 'has an impossible offset');
    offsetMinutes = (offsetHours * 60 + offsetRest) * (offset.startsWith('-') ? -1 : 1);
  }
  const epochMilliseconds = BigInt(localMilliseconds) - BigInt(offsetMinutes) * 60_000n;
  return epochMilliseconds * 1000n + BigInt(fraction.padEnd(6, '0') || '0');
}

export function microsecondsToTimestamp(parameter: string): string {
  return `(timestamptz 'epoch' + ${parameter}::bigint * interval '1 microsecond')`;
}

export function timestampToMicroseconds(column: string): string {
  return `(extract(epoch FROM ${column}) * 1000000)::bigint::text`;
}

function invalid(field: string, problem: string): ValidationError {
  const violation = `${field} ${problem}`;
  return new ValidationError(`${violation}.`, { violations: [violation] });
}
