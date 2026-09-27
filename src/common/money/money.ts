import { CurrencyMismatchError, InvalidAmountError, InvariantViolationError } from '../errors';
import { CURRENCY_CODE_PATTERN, Currency } from './currency';
import { Dec, dec } from './decimal';
import { isInt64, parseMinorString, toMajorString } from './minor-units';

/** Wire shape (design §4.1): amounts are strings, both forms carried. */
export interface MoneyView {
  currency: string;
  amountMinor: string;
  amount: string;
}

/**
 * An amount in minor units paired with its currency (design §4.1).
 *
 * - The amount is a `bigint`; a `number` is refused.
 * - Arithmetic across currencies is unrepresentable: it throws, because it is never
 *   a valid operation. The only bridge between currencies is an explicit conversion.
 * - Negative values ARE representable. A negative balance is a correct record of an
 *   overdraft (design §6.2); forbidding it is policy, enforced elsewhere.
 * - Every value fits `BIGINT`; overflow throws rather than wrapping.
 */
export class Money {
  private constructor(
    readonly amountMinor: bigint,
    readonly currency: string,
  ) {}

  static of(amountMinor: bigint, currency: string): Money {
    if (typeof amountMinor !== 'bigint') {
      throw new InvariantViolationError(
        `Money amount must be a bigint of minor units, got ${typeof amountMinor}.`,
      );
    }
    if (typeof currency !== 'string' || !CURRENCY_CODE_PATTERN.test(currency)) {
      throw new InvariantViolationError(`Invalid currency code: ${JSON.stringify(currency)}`);
    }
    if (!isInt64(amountMinor)) {
      throw new InvalidAmountError('Amount is out of range.', {
        currency,
        amountMinor: amountMinor.toString(),
      });
    }
    return new Money(amountMinor, currency);
  }

  static zero(currency: string): Money {
    return Money.of(0n, currency);
  }

  /** From the wire / database string form of minor units. */
  static fromMinorString(amountMinor: string, currency: string): Money {
    return Money.of(parseMinorString(amountMinor), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.amountMinor + other.amountMinor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.amountMinor - other.amountMinor, this.currency);
  }

  negate(): Money {
    return Money.of(-this.amountMinor, this.currency);
  }

  abs(): Money {
    return this.amountMinor < 0n ? this.negate() : this;
  }

  isZero(): boolean {
    return this.amountMinor === 0n;
  }

  isPositive(): boolean {
    return this.amountMinor > 0n;
  }

  isNegative(): boolean {
    return this.amountMinor < 0n;
  }

  /** -1 / 0 / 1. Comparing different currencies throws: there is no ordering between them. */
  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.amountMinor === other.amountMinor) return 0;
    return this.amountMinor < other.amountMinor ? -1 : 1;
  }

  /** Value equality. Different currencies are simply not equal (no throw). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.amountMinor === other.amountMinor;
  }

  isSameCurrency(other: Money): boolean {
    return this.currency === other.currency;
  }

  assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  /** Exact Decimal of the minor-unit amount, for full-precision computation. */
  toDecimalMinor(): Dec {
    return dec(this.amountMinor);
  }

  toMinorString(): string {
    return this.amountMinor.toString();
  }

  /** Wire form with both representations. Needs the Currency for its minor unit. */
  toView(currency: Currency): MoneyView {
    if (currency.code !== this.currency) {
      throw new CurrencyMismatchError(this.currency, currency.code);
    }
    return {
      currency: this.currency,
      amountMinor: this.toMinorString(),
      amount: toMajorString(this.amountMinor, currency.minorUnit),
    };
  }

  /** JSON never carries a number: `JSON.stringify(bigint)` would throw anyway. */
  toJSON(): { currency: string; amountMinor: string } {
    return { currency: this.currency, amountMinor: this.toMinorString() };
  }

  toString(): string {
    return `${this.amountMinor.toString()} ${this.currency} (minor units)`;
  }
}
