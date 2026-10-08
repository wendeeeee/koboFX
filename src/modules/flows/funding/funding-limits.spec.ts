import { ErrorCode } from '../../../common/errors';
import { FundingConfig } from '../../../config/configuration';
import { fundingAmount } from './funding-limits';

const config: FundingConfig = {
  currencies: ['NGN', 'USD'],
  limits: new Map([
    ['NGN', { minimumMinor: 10_000n, maximumMinor: 100_000_000n }],
    ['USD', { minimumMinor: 100n, maximumMinor: 1_000_000n }],
  ]),
};

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return 'OK';
};

describe('funding limits', () => {
  it('parses the string straight to minor units and applies the per-currency bounds', () => {
    expect(fundingAmount(config, '10000', 'NGN').amountMinor).toBe(10_000n);
    expect(fundingAmount(config, '100000000', 'NGN').amountMinor).toBe(100_000_000n);
    expect(codeOf(() => fundingAmount(config, '9999', 'NGN'))).toBe(ErrorCode.AMOUNT_TOO_SMALL);
    expect(codeOf(() => fundingAmount(config, '100000001', 'NGN'))).toBe(ErrorCode.AMOUNT_TOO_LARGE);
    expect(codeOf(() => fundingAmount(config, '100', 'USD'))).toBe('OK');
  });

  it('refuses currencies that are not fundable and amounts that are not whole positive minor units', () => {
    expect(codeOf(() => fundingAmount(config, '10000', 'EUR'))).toBe(ErrorCode.UNSUPPORTED_CURRENCY);
    for (const amount of ['0', '-100', '10.5', '1e5', ' 100', '0100', '']) {
      expect({ amount, code: codeOf(() => fundingAmount(config, amount, 'NGN')) }).toEqual({ amount, code: ErrorCode.INVALID_AMOUNT });
    }
  });
});
