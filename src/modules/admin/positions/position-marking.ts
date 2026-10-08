import { InvariantViolationError } from '../../../common/errors';
import { Dec, MoneyDecimal, dec } from '../../../common/money';

/**
 * Mark-to-reference of the FX position (design §5.6 "marked to a reference rate, it yields FX P&L", §15 item 2).
 * Pure `Decimal`, no floats; rounded ONCE, at the boundary, `ROUND_HALF_EVEN` to USD minor units.
 *
 * `FX_POSITION` is CREDIT-normal (Phase 2 decision 1): a positive balance is a LONG position (we received that
 * currency from users), a negative one SHORT. Marked value in USD = position ÷ 10^minorUnit ÷ usdRate, where
 * `usdRate` is the snapshot's USD-based mid (1 USD = usdRate units of the currency). The total is the exact sum
 * of the unrounded marks, rounded once — never a sum of rounded parts.
 */
export interface PositionInput {
  readonly currency: string;
  readonly minorUnit: number;
  readonly positionMinor: bigint;
  /** 1 USD = usdRate × currency; undefined when the snapshot has no rate for it. */
  readonly usdRate: Dec | undefined;
}

export interface MarkedPosition {
  readonly currency: string;
  readonly minorUnit: number;
  readonly positionMinor: bigint;
  /** In USD minor units, rounded once; null when there is no rate to mark it by. */
  readonly markedUsdMinor: bigint | null;
}

export interface MarkedBook {
  readonly positions: readonly MarkedPosition[];
  /** Σ exact marks, rounded once; null when any position could not be marked (never a partial total). */
  readonly totalMarkedUsdMinor: bigint | null;
}

const toBigint = (value: Dec): bigint => BigInt(value.toDecimalPlaces(0, MoneyDecimal.ROUND_HALF_EVEN).toFixed(0));

export function exactUsdValue(position: PositionInput, usdMinorUnit: number): Dec | null {
  if (position.usdRate === undefined) return null;
  if (!position.usdRate.gt(0)) throw new InvariantViolationError('A reference rate must be positive.', { currency: position.currency });
  // Multiply first, divide once (Phase 6 decision 9): minor → major → USD → USD minor.
  return dec(position.positionMinor).times(new MoneyDecimal(10).pow(usdMinorUnit)).div(new MoneyDecimal(10).pow(position.minorUnit).times(position.usdRate));
}

export function markBook(positions: readonly PositionInput[], usdMinorUnit: number): MarkedBook {
  let total: Dec | null = new MoneyDecimal(0);
  const marked = positions.map((position): MarkedPosition => {
    const exact = exactUsdValue(position, usdMinorUnit);
    total = exact === null || total === null ? null : total.plus(exact);
    return { currency: position.currency, minorUnit: position.minorUnit, positionMinor: position.positionMinor, markedUsdMinor: exact === null ? null : toBigint(exact) };
  });
  const finalTotal = total as Dec | null;
  return { positions: marked, totalMarkedUsdMinor: finalTotal === null ? null : toBigint(finalTotal) };
}
