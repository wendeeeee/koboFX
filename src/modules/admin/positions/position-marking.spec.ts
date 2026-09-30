import fc from 'fast-check';
import DecimalBase from 'decimal.js';
import { dec } from '../../../common/money';
import { markBook } from './position-marking';

/** The oracle's own arithmetic: far more digits than any mark needs (never the code under test's configuration). */
const Decimal = DecimalBase.clone({ precision: 80 });

describe('position mark-to-reference (Phase 10 plan §F; Decimal, rounded once)', () => {
  it('golden: the §5.6 trade — NGN +100,000,000 and USD −65,338 at 1 USD = 1,530.50 NGN → 65,338 and −65,338, total 0', () => {
    const book = markBook(
      [
        { currency: 'NGN', minorUnit: 2, positionMinor: 100_000_000n, usdRate: dec('1530.50') },
        { currency: 'USD', minorUnit: 2, positionMinor: -65_338n, usdRate: dec('1') },
      ],
      2,
    );
    expect(book.positions.map((position) => position.markedUsdMinor)).toEqual([65_338n, -65_338n]);
    expect(book.totalMarkedUsdMinor).toBe(0n);
  });

  it('JPY (0) and KWD (3) scale by their own minor units; half-even at the boundary', () => {
    const book = markBook(
      [
        { currency: 'JPY', minorUnit: 0, positionMinor: 157n, usdRate: dec('157') },
        { currency: 'KWD', minorUnit: 3, positionMinor: 1_000n, usdRate: dec('0.4') },
        { currency: 'USD', minorUnit: 2, positionMinor: 5n, usdRate: dec('2') }, // 2.5 → 2 (half-even)
      ],
      2,
    );
    expect(book.positions.map((position) => position.markedUsdMinor)).toEqual([100n, 250n, 2n]);
  });

  it('without a rate a position is not marked, and no partial total is invented', () => {
    const book = markBook([{ currency: 'NGN', minorUnit: 2, positionMinor: 1n, usdRate: undefined }], 2);
    expect(book.positions[0]!.markedUsdMinor).toBeNull();
    expect(book.totalMarkedUsdMinor).toBeNull();
  });

  it('property: the total is the exact sum of the marks, rounded ONCE (never the sum of rounded parts)', () => {
    const position = fc.record({
      minorUnit: fc.constantFrom(0, 2, 3),
      positionMinor: fc.bigInt({ min: -(10n ** 14n), max: 10n ** 14n }),
      rate: fc.integer({ min: 1, max: 10_000_000 }).map((value) => new Decimal(value).div(1000)),
    });
    fc.assert(
      fc.property(fc.array(position, { minLength: 1, maxLength: 6 }), (positions) => {
        const book = markBook(
          positions.map((entry, index) => ({ currency: `C${index}`, minorUnit: entry.minorUnit, positionMinor: entry.positionMinor, usdRate: dec(entry.rate.toFixed()) })),
          2,
        );
        const exact = positions.reduce(
          (sum, entry) => sum.plus(new Decimal(entry.positionMinor.toString()).times(100).div(new Decimal(10).pow(entry.minorUnit).times(entry.rate))),
          new Decimal(0),
        );
        expect(book.totalMarkedUsdMinor).toBe(BigInt(exact.toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toFixed(0)));
      }),
      { numRuns: 3000 },
    );
  });
});
