import { InvariantViolationError } from '../../common/errors';
import { isInt64 } from '../../common/money';
import { ConversionConfig, ConversionLimit } from '../../config/configuration';
import { AmountTooLargeError } from '../flows/funding/funding.errors';
import { ConversionAmounts } from './conversion-posting';
import { DailyLimitExceededError } from './trading.errors';

/** The configured limits for a source currency. Boot refuses a traded source currency without one. */
export function conversionLimitFor(config: ConversionConfig, sourceCurrency: string): ConversionLimit {
  const limit = config.limits.get(sourceCurrency);
  if (!limit) throw new InvariantViolationError('No conversion limits are configured for this currency.', { currency: sourceCurrency });
  return limit;
}

/**
 * Pure checks on a priced conversion, before any lock is taken: every amount must fit a
 * BIGINT (a huge TARGET-mode amount can price a debit beyond it — refused, never a 500),
 * and the debited source must not exceed the per-conversion maximum (in TARGET mode, the
 * DERIVED source). `422 AMOUNT_TOO_LARGE`.
 */
export function assertWithinConversionMaximum(config: ConversionConfig, sourceCurrency: string, amounts: ConversionAmounts): void {
  const limit = conversionLimitFor(config, sourceCurrency);
  const all = [amounts.sourceAmountMinor, amounts.targetAmountMinor, amounts.targetMidValueMinor, amounts.revenueMinor];
  if (!all.every(isInt64)) {
    throw new AmountTooLargeError('The amount is too large to convert.', { currency: sourceCurrency, maximumMinor: limit.maximumMinor.toString() });
  }
  if (amounts.sourceAmountMinor > limit.maximumMinor) {
    throw new AmountTooLargeError('The amount is above the maximum for a single conversion.', {
      currency: sourceCurrency,
      maximumMinor: limit.maximumMinor.toString(),
      sourceAmount: amounts.sourceAmountMinor.toString(),
    });
  }
}

/**
 * The rolling 24-hour limit: what the user converted from this currency in the window plus
 * this conversion must not exceed the daily maximum. Called under the source account's row
 * lock, which every conversion from that account takes first, so two conversions can never
 * both see room for only one. `422 DAILY_LIMIT_EXCEEDED`.
 */
export function assertWithinDailyLimit(
  config: ConversionConfig,
  sourceCurrency: string,
  convertedInWindowMinor: bigint,
  sourceAmountMinor: bigint,
): void {
  const limit = conversionLimitFor(config, sourceCurrency);
  if (convertedInWindowMinor + sourceAmountMinor > limit.dailyMaximumMinor) {
    const remaining = limit.dailyMaximumMinor - convertedInWindowMinor;
    throw new DailyLimitExceededError('This conversion would exceed your 24-hour conversion limit for this currency.', {
      currency: sourceCurrency,
      dailyMaximumMinor: limit.dailyMaximumMinor.toString(),
      convertedInWindowMinor: convertedInWindowMinor.toString(),
      remainingMinor: (remaining > 0n ? remaining : 0n).toString(),
      sourceAmount: sourceAmountMinor.toString(),
    });
  }
}
