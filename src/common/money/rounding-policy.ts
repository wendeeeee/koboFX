import Decimal from 'decimal.js';
import { InvalidAmountError, InvariantViolationError } from '../errors';
import { Dec, dec } from './decimal';
import { isInt64 } from './minor-units';

/**
 * Named rounding strategies, matching decimal.js semantics:
 * - ROUND_DOWN      toward zero        (conservative credit: never credit value not debited)
 * - ROUND_UP        away from zero
 * - ROUND_FLOOR     toward −∞
 * - ROUND_CEIL      toward +∞
 * - ROUND_HALF_UP   nearest, ties away from zero
 * - ROUND_HALF_EVEN nearest, ties to even (unbiased over many trades)
 */
export enum RoundingStrategy {
  ROUND_DOWN = 'ROUND_DOWN',
  ROUND_UP = 'ROUND_UP',
  ROUND_FLOOR = 'ROUND_FLOOR',
  ROUND_CEIL = 'ROUND_CEIL',
  ROUND_HALF_UP = 'ROUND_HALF_UP',
  ROUND_HALF_EVEN = 'ROUND_HALF_EVEN',
}

/** What an amount is for. Which strategy each purpose uses is configuration (design §4.4). */
export enum RoundingPurpose {
  /** The amount credited to a user in a conversion. */
  USER_CREDIT = 'USER_CREDIT',
  /** Revenue figures, e.g. the mid-value leg the spread is derived from. */
  REVENUE = 'REVENUE',
  FEE = 'FEE',
}

export type RoundingConfig = Readonly<Record<RoundingPurpose, RoundingStrategy>>;

const DECIMAL_MODE: Record<RoundingStrategy, Decimal.Rounding> = {
  [RoundingStrategy.ROUND_DOWN]: Decimal.ROUND_DOWN,
  [RoundingStrategy.ROUND_UP]: Decimal.ROUND_UP,
  [RoundingStrategy.ROUND_FLOOR]: Decimal.ROUND_FLOOR,
  [RoundingStrategy.ROUND_CEIL]: Decimal.ROUND_CEIL,
  [RoundingStrategy.ROUND_HALF_UP]: Decimal.ROUND_HALF_UP,
  [RoundingStrategy.ROUND_HALF_EVEN]: Decimal.ROUND_HALF_EVEN,
};

/**
 * The result of the single rounding step. The residual is returned, never dropped
 * ("rounding breaks sums" — design §4.4): `amountMinor + residualMinor === exactMinor`
 * exactly, and the caller is responsible for booking it.
 */
export interface RoundedAmount {
  readonly amountMinor: bigint;
  readonly exactMinor: Dec;
  /** exact − rounded, strictly within (−1, 1) minor units. */
  readonly residualMinor: Dec;
  readonly strategy: RoundingStrategy;
}

/**
 * The one place in the money path that rounds (design §4.4). Full precision is
 * carried up to here; this converts an exact amount in minor units to an integer
 * number of minor units, with an explicit strategy.
 */
export class RoundingPolicy {
  constructor(private readonly config: RoundingConfig) {
    for (const purpose of Object.values(RoundingPurpose)) {
      if (!(config[purpose] in DECIMAL_MODE)) {
        throw new InvariantViolationError(`No rounding strategy configured for ${purpose}.`);
      }
    }
  }

  strategyFor(purpose: RoundingPurpose): RoundingStrategy {
    return this.config[purpose];
  }

  /** Round for a business purpose, using the configured strategy. */
  round(exactMinor: Dec, purpose: RoundingPurpose): RoundedAmount {
    return RoundingPolicy.apply(exactMinor, this.strategyFor(purpose));
  }

  /** Round with an explicit strategy. Pure. */
  static apply(exactMinor: Dec, strategy: RoundingStrategy): RoundedAmount {
    const mode = DECIMAL_MODE[strategy];
    if (mode === undefined) {
      throw new InvariantViolationError(`Unknown rounding strategy: ${String(strategy)}`);
    }
    const exact = dec(exactMinor);
    if (!exact.isFinite()) {
      throw new InvariantViolationError(`Cannot round a non-finite amount: ${exact.toString()}`);
    }
    const rounded = exact.toDecimalPlaces(0, mode);
    const amountMinor = BigInt(rounded.toFixed(0));
    if (!isInt64(amountMinor)) {
      throw new InvalidAmountError('Rounded amount is out of range.', {
        amountMinor: amountMinor.toString(),
      });
    }
    return { amountMinor, exactMinor: exact, residualMinor: exact.minus(rounded), strategy };
  }
}
