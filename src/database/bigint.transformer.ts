import { ValueTransformer } from 'typeorm';
import { InvariantViolationError } from '../common/errors';

const DB_INTEGER = /^-?\d+$/;

/**
 * BIGINT column ⇄ JS `bigint`, via the string `pg` returns. Never via `number`:
 * a kobo balance passes `Number.MAX_SAFE_INTEGER` at about ₦90 trillion.
 */
export const bigintTransformer: ValueTransformer = {
  to(value: unknown): unknown {
    // Non-bigint values (null, FindOperators in where-clauses) pass through untouched.
    return typeof value === 'bigint' ? value.toString() : value;
  },
  from(value: unknown): bigint | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && DB_INTEGER.test(value)) return BigInt(value);
    // A number here means something upstream parsed int8 as a float: precision may be gone.
    throw new InvariantViolationError(
      `Expected BIGINT as a decimal string from the driver, got ${typeof value}.`,
    );
  },
};
