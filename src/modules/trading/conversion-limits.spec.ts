import { ErrorCode } from '../../common/errors';
import { ConversionConfig } from '../../config/configuration';
import { assertWithinConversionMaximum, assertWithinDailyLimit, conversionLimitFor } from './conversion-limits';

const config: ConversionConfig = {
  limits: new Map([
    ['NGN', { maximumMinor: 1_000_000_000n, dailyMaximumMinor: 5_000_000_000n }],
    ['USD', { maximumMinor: 1_000_000n, dailyMaximumMinor: 1_500_000n }],
  ]),
};

const amounts = (source: bigint) => ({ sourceAmountMinor: source, targetAmountMinor: 10n, targetMidValueMinor: 11n, revenueMinor: 1n });

const failure = (fn: () => unknown): { code?: string; details?: unknown } | 'OK' => {
  try {
    fn();
    return 'OK';
  } catch (error) {
    return { code: (error as { code?: string }).code, details: (error as { details?: unknown }).details };
  }
};

describe('conversion limits (Phase 7 §D.5)', () => {
  it('per-conversion maximum per source currency: inclusive, else 422 AMOUNT_TOO_LARGE', () => {
    expect(failure(() => assertWithinConversionMaximum(config, 'NGN', amounts(1_000_000_000n)))).toBe('OK');
    expect(failure(() => assertWithinConversionMaximum(config, 'NGN', amounts(1_000_000_001n)))).toEqual({
      code: ErrorCode.AMOUNT_TOO_LARGE,
      details: { currency: 'NGN', maximumMinor: '1000000000', sourceAmount: '1000000001' },
    });
  });

  it('any amount beyond BIGINT is AMOUNT_TOO_LARGE, never a 500', () => {
    expect(failure(() => assertWithinConversionMaximum(config, 'USD', { ...amounts(1n), targetMidValueMinor: 2n ** 63n }))).toMatchObject({
      code: ErrorCode.AMOUNT_TOO_LARGE,
    });
  });

  it('rolling 24-hour limit: window + this conversion ≤ daily maximum, else 422 DAILY_LIMIT_EXCEEDED with what remains', () => {
    expect(failure(() => assertWithinDailyLimit(config, 'USD', 500_000n, 1_000_000n))).toBe('OK');
    expect(failure(() => assertWithinDailyLimit(config, 'USD', 500_001n, 1_000_000n))).toEqual({
      code: ErrorCode.DAILY_LIMIT_EXCEEDED,
      details: {
        currency: 'USD',
        dailyMaximumMinor: '1500000',
        convertedInWindowMinor: '500001',
        remainingMinor: '999999',
        sourceAmount: '1000000',
      },
    });
    // Already past the limit (a lowered configuration): nothing remains, never a negative.
    expect(failure(() => assertWithinDailyLimit(config, 'USD', 2_000_000n, 1n))).toMatchObject({ details: { remainingMinor: '0' } });
  });

  it('a currency without configured limits is our misconfiguration (boot refuses it for traded currencies)', () => {
    expect(failure(() => conversionLimitFor(config, 'EUR'))).toMatchObject({ code: ErrorCode.INVARIANT_VIOLATION });
  });
});
