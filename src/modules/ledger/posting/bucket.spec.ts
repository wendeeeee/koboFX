import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { InvariantViolationError } from '../../../common/errors';
import { bucketForTransaction, systemAccountCode, userAccountCode } from './bucket';

describe('bucketing internal accounts (design §6.6)', () => {
  it('is deterministic and case-insensitive for a transaction id', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.integer({ min: 1, max: 1024 }), (transactionId, bucketCount) => {
        const bucket = bucketForTransaction(transactionId, bucketCount);
        expect(bucketForTransaction(transactionId.toUpperCase(), bucketCount)).toBe(bucket);
        expect(bucket).toBeGreaterThanOrEqual(0);
        expect(bucket).toBeLessThan(bucketCount);
      }),
    );
  });

  it('spreads transactions across all 64 buckets roughly uniformly', () => {
    const counts = new Array<number>(64).fill(0);
    for (let i = 0; i < 64_000; i += 1) counts[bucketForTransaction(randomUUID(), 64)] += 1;
    expect(Math.min(...counts)).toBeGreaterThan(800);
    expect(Math.max(...counts)).toBeLessThan(1200);
  });

  it('refuses a bucket count that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => bucketForTransaction(randomUUID(), bad)).toThrow(InvariantViolationError);
    }
  });

  it('builds account codes from the template name / wallet and the currency', () => {
    expect(systemAccountCode('REVENUE:FX_SPREAD', 'USD')).toBe('REVENUE:FX_SPREAD:USD');
    expect(userAccountCode('0b6f7c9a-1111-4222-8333-444455556666', 'NGN')).toBe(
      'USER:0b6f7c9a-1111-4222-8333-444455556666:NGN',
    );
  });
});
