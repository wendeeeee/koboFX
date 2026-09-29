import fc from 'fast-check';
import { exponentialBackoffSeconds, fullJitterDelayMilliseconds } from './backoff';

describe('backoff', () => {
  it('exponential, capped', () => {
    expect([0, 1, 2, 3, 4, 10, 100].map((attempts) => exponentialBackoffSeconds(attempts, 5, 900))).toEqual([5, 5, 10, 20, 40, 900, 900]);
  });

  it('full jitter stays in [0, min(cap, base·2^retry))', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 }), fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), (retry, random) => {
        const delay = fullJitterDelayMilliseconds(retry, 100, 2000, () => random);
        const ceiling = Math.min(2000, 100 * 2 ** retry);
        return Number.isInteger(delay) && delay >= 0 && delay < ceiling;
      }),
    );
    expect(fullJitterDelayMilliseconds(3, 100, 2000, () => 0)).toBe(0);
  });
});
