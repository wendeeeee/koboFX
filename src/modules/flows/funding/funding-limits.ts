import { InvalidAmountError, UnsupportedCurrencyError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { FundingConfig } from '../../../config/configuration';
import { AmountTooLargeError, AmountTooSmallError } from './funding.errors';

/**
 * Validates a funding request's amount against the configured per-currency bounds.
 * Pure. The amount arrives as a string of minor units and is parsed straight to a
 * bigint — it never passes through a JS number.
 */
export function fundingAmount(
  config: FundingConfig,
  amountMinor: string,
  currency: string,
  /** The provider's funding currencies (default: the simulated PSP's). The limits are shared. */
  currencies: readonly string[] = config.currencies,
): Money {
  const limit = config.limits.get(currency);
  if (!currencies.includes(currency) || !limit) throw new UnsupportedCurrencyError(currency);
  if (!/^[1-9]\d{0,17}$/.test(amountMinor)) {
    throw new InvalidAmountError('Amount must be a positive whole number of minor units, as a string.', { amountMinor });
  }
  const amount = Money.fromMinorString(amountMinor, currency);
  if (amount.amountMinor < limit.minimumMinor) {
    throw new AmountTooSmallError('Amount is below the minimum funding amount.', {
      currency,
      minimumMinor: limit.minimumMinor.toString(),
    });
  }
  if (amount.amountMinor > limit.maximumMinor) {
    throw new AmountTooLargeError('Amount is above the maximum funding amount.', {
      currency,
      maximumMinor: limit.maximumMinor.toString(),
    });
  }
  return amount;
}
