import fc from 'fast-check';
import { InvalidAmountError, InvariantViolationError } from '../../common/errors';
import { Dec, MoneyDecimal, RoundingPolicy, RoundingPurpose, RoundingStrategy, dec, majorToExactMinor, minorToMajorDecimal } from '../../common/money';
import { QuoteAmountMode, clientRateOf, displayRate, exactRateString, priceConversion, triangulatedMid } from './pricing';

const ROUNDING = new RoundingPolicy({
  [RoundingPurpose.USER_CREDIT]: RoundingStrategy.ROUND_DOWN,
  [RoundingPurpose.USER_DEBIT]: RoundingStrategy.ROUND_UP,
  [RoundingPurpose.REVENUE]: RoundingStrategy.ROUND_HALF_EVEN,
  [RoundingPurpose.FEE]: RoundingStrategy.ROUND_HALF_EVEN,
});

type Currency = readonly [string, number];
const NGN: Currency = ['NGN', 2];
const USD: Currency = ['USD', 2];
const EUR: Currency = ['EUR', 2];
const GBP: Currency = ['GBP', 2];
const JPX: Currency = ['JPX', 0];
const KWX: Currency = ['KWX', 3];

function price(source: Currency, target: Currency, sourceUsd: string, targetUsd: string, spread: number, mode: QuoteAmountMode, amount: string) {
  return priceConversion(
    {
      source: { code: source[0], minorUnit: source[1] },
      target: { code: target[0], minorUnit: target[1] },
      sourceUsdRate: dec(sourceUsd),
      targetUsdRate: dec(targetUsd),
      spreadBasisPoints: spread,
      mode,
      amountMinor: BigInt(amount),
    },
    ROUNDING,
  );
}

const { SOURCE, TARGET } = QuoteAmountMode;

describe('pricing — golden (design §11)', () => {
  it('reproduces the design §5.6 worked example exactly: ₦1,000,000 at 1,530.50, 50 bps', () => {
    const priced = price(NGN, USD, '1530.50', '1', 50, SOURCE, '100000000');
    expect(priced.targetAmountMinor).toBe(65_011n);
    expect(priced.targetMidValueMinor).toBe(65_338n);
    expect(priced.revenueMinor).toBe(327n);
    expect(priced.midRate.toFixed()).toBe('0.0006533812479581836001306762495916367');
    expect(priced.exactMidTargetMinor.toFixed(4)).toBe('65338.1248');
    expect(priced.exactClientTargetMinor.toFixed(4)).toBe('65011.4342');
  });

  const corpus: [string, Currency, Currency, string, string, number, QuoteAmountMode, string, [string, string, string, string]][] = [
    ['real 2026-09-29 NGN mid, ₦1,000 → USD (task example)', NGN, USD, '1329.375909', '1', 150, SOURCE, '100000', ['100000', '74', '75', '1']],
    ['pair minimum ₦1,000 → EUR (triangulated cross)', NGN, EUR, '1329.375909', '0.879241', 150, SOURCE, '100000', ['100000', '65', '66', '1']],
    ['€50 → NGN (task example)', EUR, NGN, '0.879241', '1329.375909', 150, SOURCE, '5000', ['5000', '7446395', '7559793', '113398']],
    ['$1 → NGN (pair minimum)', USD, NGN, '1', '1329.375909', 150, SOURCE, '100', ['100', '130943', '132938', '1995']],
    ['EUR → GBP cross, majors spread', EUR, GBP, '0.879241', '0.754467', 50, SOURCE, '123456', ['123456', '105406', '105936', '530']],
    ['0-decimal target (JPY-like)', USD, JPX, '1', '157.315109', 50, SOURCE, '999', ['999', '1563', '1572', '9']],
    ['0-decimal source (JPY-like) → NGN', JPX, NGN, '157.315109', '1329.375909', 150, SOURCE, '7', ['7', '5826', '5915', '89']],
    ['3-decimal target (KWD-like)', USD, KWX, '1', '0.308645', 50, SOURCE, '100', ['100', '307', '309', '2']],
    ['3-decimal source (KWD-like) → NGN', KWX, NGN, '0.308645', '1329.375909', 150, SOURCE, '1', ['1', '424', '431', '7']],
    ['tiny mid: 1 kobo → USD credits zero (the service refuses AMOUNT_TOO_SMALL)', NGN, USD, '1329.375909', '1', 150, SOURCE, '1', ['1', '0', '0', '0']],
    ['near BIGINT: INT64_MAX kobo → USD', NGN, USD, '1329.375909', '1', 150, SOURCE, '9223372036854775807', ['9223372036854775807', '6834050019107089', '6938121846809228', '104071827702139']],
    ['zero spread: revenue is the rounding residual only', USD, EUR, '1', '0.879241', 0, SOURCE, '100', ['100', '87', '88', '1']],
    ['TARGET: buy $50 with NGN (§7.7)', NGN, USD, '1329.375909', '1', 150, TARGET, '5000', ['6748102', '5000', '5076', '76']],
    ['TARGET: receive ₦100,000 for EUR', EUR, NGN, '0.879241', '1329.375909', 150, TARGET, '10000000', ['6715', '10000000', '10152801', '152801']],
    ['TARGET: 0-decimal source rounds UP (never debit less than delivered)', JPX, USD, '157.315109', '1', 50, TARGET, '1', ['2', '1', '1', '0']],
    ['TARGET: 3-decimal target', USD, KWX, '1', '0.308645', 50, TARGET, '1', ['1', '1', '3', '2']],
    ['provider digits beyond 12 dp are all used', NGN, USD, '1530.123456789012345', '1', 150, SOURCE, '100000000', ['100000000', '64373', '65354', '981']],
  ];

  it.each(corpus)('%s', (_name, source, target, sourceUsd, targetUsd, spread, mode, amount, expected) => {
    const priced = price(source, target, sourceUsd, targetUsd, spread, mode, amount);
    expect([priced.sourceAmountMinor, priced.targetAmountMinor, priced.targetMidValueMinor, priced.revenueMinor].map(String)).toEqual(expected);
  });

  it('refuses an amount whose result does not fit BIGINT (USD → NGN at INT64_MAX cents)', () => {
    expect(() => price(USD, NGN, '1', '1329.375909', 150, SOURCE, '9223372036854775807')).toThrow(InvalidAmountError);
  });

  it('refuses nonsense inputs loudly', () => {
    expect(() => price(USD, USD, '1', '1', 50, SOURCE, '100')).toThrow(InvariantViolationError);
    expect(() => price(USD, EUR, '1', '0.9', 50, SOURCE, '0')).toThrow(InvariantViolationError);
    expect(() => price(USD, EUR, '0', '0.9', 50, SOURCE, '100')).toThrow(InvariantViolationError);
    expect(() => price(USD, EUR, '1', '-0.9', 50, SOURCE, '100')).toThrow(InvariantViolationError);
    for (const spread of [-1, 10_000, 1.5]) expect(() => price(USD, EUR, '1', '0.9', spread, SOURCE, '100')).toThrow(InvariantViolationError);
    const upward = new RoundingPolicy({
      [RoundingPurpose.USER_CREDIT]: RoundingStrategy.ROUND_UP,
      [RoundingPurpose.USER_DEBIT]: RoundingStrategy.ROUND_UP,
      [RoundingPurpose.REVENUE]: RoundingStrategy.ROUND_DOWN,
      [RoundingPurpose.FEE]: RoundingStrategy.ROUND_DOWN,
    });
    expect(() =>
      priceConversion(
        { source: { code: 'USD', minorUnit: 2 }, target: { code: 'EUR', minorUnit: 2 }, sourceUsdRate: dec('1'), targetUsdRate: dec('0.879241'), spreadBasisPoints: 0, mode: SOURCE, amountMinor: 100n },
        upward,
      ),
    ).toThrow(/revenue is negative/);
  });
});

describe('rates for display', () => {
  it('shows 12 significant digits in plain notation, half-even; storage keeps every digit', () => {
    const mid = triangulatedMid(dec('1329.375909'), dec('1'));
    expect(displayRate(mid)).toBe('0.000752232677928');
    expect(displayRate(dec('1329.375909'))).toBe('1329.375909');
    expect(displayRate(dec('0.0000000000123456789012345'))).toBe('0.0000000000123456789012');
    expect(displayRate(dec('2.50000000000050'))).toBe('2.5');
    expect(exactRateString(dec('1530.123456789012345'))).toBe('1530.123456789012345');
  });
});


const usdRate: fc.Arbitrary<Dec> = fc.oneof(
  fc.bigInt({ min: 1n, max: 10n ** 9n }).map((n) => dec(n).div(new MoneyDecimal(10).pow(9))),
  fc.bigInt({ min: 10n ** 6n, max: 10n ** 13n }).map((n) => dec(n).div(new MoneyDecimal(10).pow(6))),
  fc.bigInt({ min: 1n, max: 10n ** 12n }).map((n) => dec(n).div(new MoneyDecimal(10).pow(6))),
);
const minorUnit = fc.constantFrom(0, 2, 3);
const spread = fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 500 }), fc.integer({ min: 1, max: 9_999 }));
const amount = fc.oneof(fc.bigInt({ min: 1n, max: 1_000n }), fc.bigInt({ min: 1n, max: 10n ** 12n }));

const scenario = fc.record({
  sourceMinorUnit: minorUnit,
  targetMinorUnit: minorUnit,
  sourceUsdRate: usdRate,
  targetUsdRate: usdRate,
  spreadBasisPoints: spread,
  mode: fc.constantFrom(SOURCE, TARGET),
  amountMinor: amount,
});

type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;

function priceScenario(s: Scenario) {
  return priceConversion(
    {
      source: { code: 'AAA', minorUnit: s.sourceMinorUnit },
      target: { code: 'BBB', minorUnit: s.targetMinorUnit },
      sourceUsdRate: s.sourceUsdRate,
      targetUsdRate: s.targetUsdRate,
      spreadBasisPoints: s.spreadBasisPoints,
      mode: s.mode,
      amountMinor: s.amountMinor,
    },
    ROUNDING,
  );
}

describe('pricing — properties (the invariant is the oracle)', () => {
  it('for any mid, spread and amount: sell ≤ mid ≤ buy, credit ≤ mid value, revenue = mid value − credit ≥ 0, one residual only', () => {
    let spreadPositive = 0;
    let targetMode = 0;
    let nonzeroRevenue = 0;
    fc.assert(
      fc.property(scenario, (s) => {
        let priced;
        try {
          priced = priceScenario(s);
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidAmountError);
          return;
        }
        const mid = priced.midRate;
        const sell = priced.clientRate;
        const buy = new MoneyDecimal(1).div(clientRateOf(triangulatedMid(s.targetUsdRate, s.sourceUsdRate), s.spreadBasisPoints));
        const tolerance = mid.times('1e-30');
        expect(sell.lte(mid)).toBe(true);
        expect(buy.gte(mid.minus(tolerance))).toBe(true);
        if (s.spreadBasisPoints > 0) {
          spreadPositive += 1;
          expect(sell.lt(mid)).toBe(true);
          expect(buy.gt(mid)).toBe(true);
        }
        expect(priced.targetAmountMinor <= priced.targetMidValueMinor).toBe(true);
        expect(priced.revenueMinor).toBe(priced.targetMidValueMinor - priced.targetAmountMinor);
        expect(priced.revenueMinor >= 0n).toBe(true);
        if (priced.revenueMinor > 0n) nonzeroRevenue += 1;
        expect(dec(priced.targetAmountMinor).lte(priced.exactClientTargetMinor)).toBe(true);
        if (s.mode === SOURCE) expect(priced.exactClientTargetMinor.minus(dec(priced.targetAmountMinor)).lt(1)).toBe(true);
        expect(priced.exactMidTargetMinor.minus(dec(priced.targetMidValueMinor)).abs().lte(new MoneyDecimal('0.5'))).toBe(true);
        if (s.mode === TARGET) {
          targetMode += 1;
          const oneLess = minorToMajorDecimal(priced.sourceAmountMinor - 1n, s.sourceMinorUnit);
          const atOneLess = majorToExactMinor(oneLess.times(priced.clientRate), s.targetMinorUnit);
          expect(priced.exactClientTargetMinor.gte(dec(priced.targetAmountMinor).minus('1e-20'))).toBe(true);
          expect(atOneLess.lt(dec(priced.targetAmountMinor).plus('1e-20'))).toBe(true);
        }
      }),
      { numRuns: 2_000 },
    );
    expect(spreadPositive).toBeGreaterThan(100);
    expect(targetMode).toBeGreaterThan(100);
    expect(nonzeroRevenue).toBeGreaterThan(100);
  });

  it('directional quotes do not invert once a spread is applied; triangulated reference mids do', () => {
    fc.assert(
      fc.property(usdRate, usdRate, fc.integer({ min: 1, max: 9_999 }), (a, b, bps) => {
        const forward = triangulatedMid(a, b);
        const backward = triangulatedMid(b, a);
        expect(forward.times(backward).minus(1).abs().lt('1e-32')).toBe(true);
        const roundTrip = clientRateOf(forward, bps).times(clientRateOf(backward, bps));
        expect(roundTrip.lt(1)).toBe(true);
      }),
      { numRuns: 1_000 },
    );
  });
});
