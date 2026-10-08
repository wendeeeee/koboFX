import fc from 'fast-check';
import { assertWithinWithdrawalLimits, parseWithdrawalLimits, WithdrawalLimit } from './withdrawal-limits';
import {
  PROVIDER_REFERENCE_PATTERN,
  principalReferenceOf,
  principalReversalReferenceOf,
  providerFeeReferenceOf,
  providerReferenceOf,
} from './withdrawal-references';

describe('parseWithdrawalLimits', () => {
  const parse = (json: string | undefined) => {
    const problems: string[] = [];
    return { limits: parseWithdrawalLimits(json, problems), problems };
  };

  it('parses strings of minor units exactly, beyond 2^53', () => {
    const { limits, problems } = parse(
      JSON.stringify({ NGN: { minimum: '10000', maximum: '9007199254740993', dailyMaximum: '900719925474099300' } }),
    );
    expect(problems).toEqual([]);
    expect(limits?.get('NGN')).toEqual({
      minimumMinor: 10_000n,
      maximumMinor: 9_007_199_254_740_993n,
      dailyMaximumMinor: 900_719_925_474_099_300n,
    });
  });

  it.each([
    [undefined, /is required/],
    ['not json', /must be JSON/],
    ['[]', /must map currency/],
    ['{}', /must map currency/],
    [JSON.stringify({ NGN: { minimum: 10000, maximum: '1', dailyMaximum: '1' } }), /positive strings of minor units/],
    [JSON.stringify({ NGN: { minimum: '1.5', maximum: '2', dailyMaximum: '3' } }), /positive strings of minor units/],
    [JSON.stringify({ NGN: { minimum: '0', maximum: '2', dailyMaximum: '3' } }), /positive strings of minor units/],
    [JSON.stringify({ NGN: { minimum: '1', maximum: '2', dailyMaximum: '3', extra: '1' } }), /exactly minimum, maximum and dailyMaximum/],
    [JSON.stringify({ ngn: { minimum: '1', maximum: '2', dailyMaximum: '3' } }), /positive strings of minor units/],
    [JSON.stringify({ NGN: { minimum: '3', maximum: '2', dailyMaximum: '3' } }), /minimum ≤ maximum ≤ dailyMaximum/],
    [JSON.stringify({ NGN: { minimum: '1', maximum: '4', dailyMaximum: '3' } }), /minimum ≤ maximum ≤ dailyMaximum/],
  ])('refuses %s', (json, pattern) => {
    const { limits, problems } = parse(json);
    expect(limits).toBeUndefined();
    expect(problems.join('\n')).toMatch(pattern);
  });
});

describe('assertWithinWithdrawalLimits', () => {
  const limit: WithdrawalLimit = { minimumMinor: 10_000n, maximumMinor: 100_000_000n, dailyMaximumMinor: 500_000_000n };

  it('refuses below the minimum, above the maximum, and past the rolling limit — with stable codes', () => {
    const none = { outstandingMinor: 0n, completedInWindowMinor: 0n };
    expect(() => assertWithinWithdrawalLimits(limit, 'NGN', 9_999n, none)).toThrow(expect.objectContaining({ code: 'AMOUNT_TOO_SMALL' }));
    expect(() => assertWithinWithdrawalLimits(limit, 'NGN', 100_000_001n, none)).toThrow(
      expect.objectContaining({ code: 'AMOUNT_TOO_LARGE' }),
    );
    expect(() =>
      assertWithinWithdrawalLimits(limit, 'NGN', 100_000_000n, { outstandingMinor: 300_000_000n, completedInWindowMinor: 100_000_001n }),
    ).toThrow(expect.objectContaining({ code: 'DAILY_LIMIT_EXCEEDED' }));
    expect(() =>
      assertWithinWithdrawalLimits(limit, 'NGN', 100_000_000n, { outstandingMinor: 300_000_000n, completedInWindowMinor: 100_000_000n }),
    ).not.toThrow();
  });

  it('property: passes exactly when minimum ≤ amount ≤ maximum and outstanding + completed + amount ≤ dailyMaximum', () => {
    const minor = fc.bigInt({ min: 1n, max: 10n ** 18n });
    fc.assert(
      fc.property(minor, minor, minor, fc.bigInt({ min: 0n, max: 10n ** 18n }), fc.bigInt({ min: 0n, max: 10n ** 18n }), minor,
        (a, b, c, outstanding, completed, amount) => {
          const [minimumMinor, maximumMinor, dailyMaximumMinor] = [a, b, c].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
          const bounds = { minimumMinor, maximumMinor, dailyMaximumMinor };
          const usage = { outstandingMinor: outstanding, completedInWindowMinor: completed };
          const expected =
            amount >= minimumMinor && amount <= maximumMinor && outstanding + completed + amount <= dailyMaximumMinor;
          let passed = true;
          try {
            assertWithinWithdrawalLimits(bounds, 'NGN', amount, usage);
          } catch {
            passed = false;
          }
          return passed === expected;
        }),
      { numRuns: 500 },
    );
  });
});

describe('withdrawal references', () => {
  const flowId = '3f2c4c3e-8d2b-4a51-9b6f-0e1d2c3b4a59';

  it('derives every reference from the flow id; the provider reference fits Paystack’s rule', () => {
    expect(providerReferenceOf(flowId)).toBe(`withdrawal-${flowId}`);
    expect(providerReferenceOf(flowId)).toHaveLength(47);
    expect(providerReferenceOf(flowId.toUpperCase())).toBe(`withdrawal-${flowId}`);
    expect(providerReferenceOf(flowId)).toMatch(/^[a-z0-9_-]{16,50}$/);
    expect(providerReferenceOf(flowId)).toMatch(PROVIDER_REFERENCE_PATTERN);
    expect(principalReferenceOf(flowId)).toBe(`withdrawal:${flowId}`);
    expect(principalReversalReferenceOf(flowId)).toBe(`withdrawal-reversal:${flowId}`);
    expect(providerFeeReferenceOf(flowId, '9876', 'transfer_fee')).toBe(`withdrawal-provider-fee:${flowId}:9876:transfer_fee`);
  });

  it('refuses a non-v4 flow id and unbounded fee identities', () => {
    expect(() => providerReferenceOf('3f2c4c3e-8d2b-1a51-9b6f-0e1d2c3b4a59')).toThrow(/version-4 UUID/);
    expect(() => providerReferenceOf('not-a-uuid')).toThrow(/version-4 UUID/);
    expect(() => providerFeeReferenceOf(flowId, 'a b', 'transfer_fee')).toThrow(/bounded/);
    expect(() => providerFeeReferenceOf(flowId, '1', 'Transfer Fee')).toThrow(/bounded/);
  });
});
