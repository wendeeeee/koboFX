import { InvariantViolationError } from '../../common/errors';
import { AmountTooLargeError, AmountTooSmallError } from '../flows/funding/funding.errors';
import { DailyLimitExceededError } from '../trading/trading.errors';


export interface WithdrawalLimit {
  readonly minimumMinor: bigint;
  readonly maximumMinor: bigint;
  readonly dailyMaximumMinor: bigint;
}

export interface WithdrawalUsage {

  readonly outstandingMinor: bigint;
 
  readonly completedInWindowMinor: bigint;
}

const MINOR_UNITS = /^[1-9]\d{0,17}$/;

export function parseWithdrawalLimits(
  limitsJson: string | undefined,
  problems: string[],
): ReadonlyMap<string, WithdrawalLimit> | undefined {
  if (!limitsJson) {
    problems.push('PAYSTACK_WITHDRAWAL_LIMITS is required');
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(limitsJson);
  } catch {
    problems.push('PAYSTACK_WITHDRAWAL_LIMITS must be JSON');
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    problems.push('PAYSTACK_WITHDRAWAL_LIMITS must map currency to {minimum, maximum, dailyMaximum}');
    return undefined;
  }
  const limits = new Map<string, WithdrawalLimit>();
  let valid = true;
  for (const [currency, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const { minimum, maximum, dailyMaximum, ...rest } = (entry ?? {}) as Record<string, unknown>;
    if (
      !/^[A-Z]{3}$/.test(currency) ||
      Object.keys(rest).length > 0 ||
      ![minimum, maximum, dailyMaximum].every((value) => typeof value === 'string' && MINOR_UNITS.test(value))
    ) {
      problems.push(`PAYSTACK_WITHDRAWAL_LIMITS.${currency} needs exactly minimum, maximum and dailyMaximum as positive strings of minor units`);
      valid = false;
      continue;
    }
    const limit = {
      minimumMinor: BigInt(minimum as string),
      maximumMinor: BigInt(maximum as string),
      dailyMaximumMinor: BigInt(dailyMaximum as string),
    };
    if (limit.minimumMinor > limit.maximumMinor || limit.maximumMinor > limit.dailyMaximumMinor) {
      problems.push(`PAYSTACK_WITHDRAWAL_LIMITS.${currency} must satisfy minimum ≤ maximum ≤ dailyMaximum`);
      valid = false;
      continue;
    }
    limits.set(currency, limit);
  }
  return valid ? limits : undefined;
}


export function assertWithinWithdrawalLimits(
  limit: WithdrawalLimit,
  currency: string,
  principalMinor: bigint,
  usage: WithdrawalUsage,
): void {
  if (principalMinor <= 0n) {
    throw new InvariantViolationError('A withdrawal principal is positive.', { principalMinor: principalMinor.toString() });
  }
  if (principalMinor < limit.minimumMinor) {
    throw new AmountTooSmallError('Amount is below the minimum withdrawal amount.', {
      currency,
      minimumMinor: limit.minimumMinor.toString(),
    });
  }
  if (principalMinor > limit.maximumMinor) {
    throw new AmountTooLargeError('Amount is above the maximum withdrawal amount.', {
      currency,
      maximumMinor: limit.maximumMinor.toString(),
    });
  }
  const committed = usage.outstandingMinor + usage.completedInWindowMinor;
  if (committed + principalMinor > limit.dailyMaximumMinor) {
    const remaining = limit.dailyMaximumMinor - committed;
    throw new DailyLimitExceededError('This withdrawal would exceed your 24-hour withdrawal limit for this currency.', {
      currency,
      dailyMaximumMinor: limit.dailyMaximumMinor.toString(),
      outstandingMinor: usage.outstandingMinor.toString(),
      completedInWindowMinor: usage.completedInWindowMinor.toString(),
      remainingMinor: (remaining > 0n ? remaining : 0n).toString(),
      amount: principalMinor.toString(),
    });
  }
}
