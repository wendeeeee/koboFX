import Decimal from 'decimal.js';
import { InvariantViolationError } from '../errors';

/**
 * The one Decimal configuration used in the money path (design §4.1): 34 significant
 * digits (decimal128), and plain notation always — an exponent in a serialised amount
 * is a parsing hazard at every boundary.
 *
 * `rounding` here only governs precision loss beyond 34 significant digits inside a
 * chain of operations. Rounding *to minor units* is never implicit; it happens once,
 * explicitly, in `RoundingPolicy`.
 */
export const MoneyDecimal = Decimal.clone({
  precision: 34,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

export type Dec = Decimal;

const PLAIN_DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/**
 * Construct a Decimal from a string or bigint. Deliberately does not accept a JS
 * `number`: once a value has been an IEEE-754 double, precision may already be gone.
 */
export function dec(value: string | bigint | Decimal): Decimal {
  if (typeof value === 'bigint') return new MoneyDecimal(value.toString());
  if (typeof value === 'string') {
    if (!PLAIN_DECIMAL.test(value)) {
      throw new InvariantViolationError(`Not a plain decimal string: ${JSON.stringify(value)}`);
    }
    return new MoneyDecimal(value);
  }
  if (Decimal.isDecimal(value)) return new MoneyDecimal(value);
  // Reachable only from untyped callers — the signature forbids it.
  throw new InvariantViolationError(
    `Refusing to build a Decimal from ${typeof value}; floats never enter the money path.`,
  );
}
