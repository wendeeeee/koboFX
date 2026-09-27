import { InvalidAmountError, InvariantViolationError } from '../errors';
import { MAX_MINOR_UNIT } from './currency';
import { Dec, MoneyDecimal, dec } from './decimal';

/** Storage is `BIGINT`: every persisted amount must fit a signed 64-bit integer. */
export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = 2n ** 63n - 1n;

export function isInt64(value: bigint): boolean {
  return value >= INT64_MIN && value <= INT64_MAX;
}

export function assertMinorUnit(minorUnit: number): void {
  if (!Number.isInteger(minorUnit) || minorUnit < 0 || minorUnit > MAX_MINOR_UNIT) {
    throw new InvariantViolationError(`Invalid minor unit: ${minorUnit}`, { minorUnit });
  }
}

/**
 * Minor units → canonical major-unit string, using bigint arithmetic only.
 * `toMajorString(125000n, 2) === "1250.00"`, `toMajorString(125n, 0) === "125"`.
 */
export function toMajorString(amountMinor: bigint, minorUnit: number): string {
  assertMinorUnit(minorUnit);
  const negative = amountMinor < 0n;
  const digits = (negative ? -amountMinor : amountMinor).toString().padStart(minorUnit + 1, '0');
  const whole = digits.slice(0, digits.length - minorUnit);
  const fraction = digits.slice(digits.length - minorUnit);
  return `${negative ? '-' : ''}${minorUnit === 0 ? whole : `${whole}.${fraction}`}`;
}

const MAJOR_AMOUNT = /^(-)?(0|[1-9]\d*)(?:\.(\d+))?$/;

/**
 * Major-unit string → minor units, exactly. Never rounds: precision beyond the
 * currency's minor unit is rejected unless the extra digits are zeros.
 */
export function parseMajorString(value: string, minorUnit: number): bigint {
  assertMinorUnit(minorUnit);
  const match = MAJOR_AMOUNT.exec(value);
  if (!match) {
    throw new InvalidAmountError(`Not a decimal amount: ${JSON.stringify(value)}`);
  }
  const [, sign, whole, rawFraction = ''] = match;
  const significant = rawFraction.slice(0, minorUnit);
  const excess = rawFraction.slice(minorUnit);
  if (/[1-9]/.test(excess)) {
    throw new InvalidAmountError(`Amount has more precision than the currency allows.`, {
      amount: value,
      minorUnit,
    });
  }
  const magnitude = BigInt(`${whole}${significant.padEnd(minorUnit, '0')}`);
  const result = sign ? -magnitude : magnitude;
  if (!isInt64(result)) {
    throw new InvalidAmountError('Amount is out of range.', { amount: value });
  }
  return result;
}

const MINOR_AMOUNT = /^-?(0|[1-9]\d*)$/;

/** Wire string of minor units → bigint. Strict: canonical integers only, BIGINT range. */
export function parseMinorString(value: string): bigint {
  if (typeof value !== 'string' || !MINOR_AMOUNT.test(value) || value === '-0') {
    throw new InvalidAmountError(`Not an integer amount in minor units: ${JSON.stringify(value)}`);
  }
  const result = BigInt(value);
  if (!isInt64(result)) {
    throw new InvalidAmountError('Amount is out of range.', { amountMinor: value });
  }
  return result;
}

function scale(minorUnit: number): Dec {
  assertMinorUnit(minorUnit);
  return new MoneyDecimal(10).pow(minorUnit);
}

/** Minor units → exact Decimal in major units (for FX math). Division by 10^n is exact. */
export function minorToMajorDecimal(amountMinor: bigint, minorUnit: number): Dec {
  return dec(amountMinor).div(scale(minorUnit));
}

/**
 * Exact major-unit Decimal → exact (unrounded) Decimal in minor units. The caller
 * then rounds exactly once through `RoundingPolicy`.
 */
export function majorToExactMinor(major: Dec, minorUnit: number): Dec {
  return dec(major).times(scale(minorUnit));
}
