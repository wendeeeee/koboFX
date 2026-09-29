import fc from 'fast-check';
import { ErrorCode, InvalidAmountError, InvariantViolationError } from '../../common/errors';
import { RoundingPolicy, RoundingPurpose, RoundingStrategy, dec } from '../../common/money';
import { PricedCurrency, QuoteAmountMode, priceConversion } from '../fx/pricing';
import { EntryDirection } from '../ledger/ledger.types';
import {
  ConversionAmounts,
  assertConversionAmounts,
  assertRateDisplayReproduces,
  conversionEntries,
  effectiveRateOf,
  rateDisplayOf,
  rateDisplayToleranceMinor,
} from './conversion-posting';

const ROUNDING = new RoundingPolicy({
  [RoundingPurpose.USER_CREDIT]: RoundingStrategy.ROUND_DOWN,
  [RoundingPurpose.USER_DEBIT]: RoundingStrategy.ROUND_UP,
  [RoundingPurpose.REVENUE]: RoundingStrategy.ROUND_HALF_EVEN,
  [RoundingPurpose.FEE]: RoundingStrategy.ROUND_HALF_EVEN,
});

const NGN: PricedCurrency = { code: 'NGN', minorUnit: 2 };
const USD: PricedCurrency = { code: 'USD', minorUnit: 2 };
const EUR: PricedCurrency = { code: 'EUR', minorUnit: 2 };
const GBP: PricedCurrency = { code: 'GBP', minorUnit: 2 };
/** Test currencies with JPY-like (0) and KWD-like (3) minor units. */
const JPX: PricedCurrency = { code: 'JPX', minorUnit: 0 };
const KWX: PricedCurrency = { code: 'KWX', minorUnit: 3 };

const SOURCE_ACCOUNT = '00000000-0000-4000-8000-00000000000a';
const TARGET_ACCOUNT = '00000000-0000-4000-8000-00000000000b';

function price(source: PricedCurrency, target: PricedCurrency, sourceUsd: string, targetUsd: string, spread: number, mode: QuoteAmountMode, amount: bigint) {
  return priceConversion(
    { source, target, sourceUsdRate: dec(sourceUsd), targetUsdRate: dec(targetUsd), spreadBasisPoints: spread, mode, amountMinor: amount },
    ROUNDING,
  );
}

/** Entries as `account direction amount currency` lines: a readable golden. */
function golden(source: PricedCurrency, target: PricedCurrency, amounts: ConversionAmounts): string[] {
  return conversionEntries({ source, target, sourceAccountId: SOURCE_ACCOUNT, targetAccountId: TARGET_ACCOUNT, amounts }).map((entry) => {
    const account = 'accountId' in entry.account ? (entry.account.accountId === SOURCE_ACCOUNT ? 'USER:source' : 'USER:target') : entry.account.systemAccount;
    return `${account} ${entry.direction} ${entry.amount.toMinorString()} ${entry.amount.currency}`;
  });
}

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return 'OK';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

describe('conversion posting — golden (design §5.6, §11)', () => {
  it('posts the §5.6 worked example: ₦1,000,000 at 1,530.50, 50 bps → five entries', () => {
    const priced = price(NGN, USD, '1530.50', '1', 50, QuoteAmountMode.SOURCE, 100_000_000n);
    expect(golden(NGN, USD, priced)).toEqual([
      'USER:source DEBIT 100000000 NGN',
      'FX_POSITION CREDIT 100000000 NGN',
      'FX_POSITION DEBIT 65338 USD',
      'USER:target CREDIT 65011 USD',
      'REVENUE:FX_SPREAD CREDIT 327 USD',
    ]);
    expect(rateDisplayOf(NGN, 100_000_000n, USD, 65_011n)).toBe('0.00065011');
  });

  it.each([
    ['₦1,000 → USD (task example, 150 bps)', NGN, USD, '1329.375909', '1', 150, QuoteAmountMode.SOURCE, 100_000n,
      ['USER:source DEBIT 100000 NGN', 'FX_POSITION CREDIT 100000 NGN', 'FX_POSITION DEBIT 75 USD', 'USER:target CREDIT 74 USD', 'REVENUE:FX_SPREAD CREDIT 1 USD']],
    ['€50 → NGN (task example): revenue in the target, NGN', EUR, NGN, '0.879241', '1329.375909', 150, QuoteAmountMode.SOURCE, 5_000n,
      ['USER:source DEBIT 5000 EUR', 'FX_POSITION CREDIT 5000 EUR', 'FX_POSITION DEBIT 7559793 NGN', 'USER:target CREDIT 7446395 NGN', 'REVENUE:FX_SPREAD CREDIT 113398 NGN']],
    ['EUR → GBP, a major cross (50 bps)', EUR, GBP, '0.879241', '0.745', 50, QuoteAmountMode.SOURCE, 100_000n,
      ['USER:source DEBIT 100000 EUR', 'FX_POSITION CREDIT 100000 EUR', 'FX_POSITION DEBIT 84732 GBP', 'USER:target CREDIT 84308 GBP', 'REVENUE:FX_SPREAD CREDIT 424 GBP']],
    ['TARGET mode: "buy $50 with NGN" — the debit is derived (ROUND_UP)', NGN, USD, '1329.375909', '1', 150, QuoteAmountMode.TARGET, 5_000n,
      ['USER:source DEBIT 6748102 NGN', 'FX_POSITION CREDIT 6748102 NGN', 'FX_POSITION DEBIT 5076 USD', 'USER:target CREDIT 5000 USD', 'REVENUE:FX_SPREAD CREDIT 76 USD']],
    ['a 0-decimal source (JPX) into a 3-decimal target (KWX)', JPX, KWX, '150', '0.307', 50, QuoteAmountMode.SOURCE, 10_000n,
      ['USER:source DEBIT 10000 JPX', 'FX_POSITION CREDIT 10000 JPX', 'FX_POSITION DEBIT 20467 KWX', 'USER:target CREDIT 20364 KWX', 'REVENUE:FX_SPREAD CREDIT 103 KWX']],
  ] as const)('%s', (_name, source, target, sourceUsd, targetUsd, spread, mode, amount, expected) => {
    const priced = price(source, target, sourceUsd, targetUsd, spread, mode, amount);
    expect(golden(source, target, priced)).toEqual(expected);
  });

  it('a zero revenue posts FOUR entries, never a zero-amount fifth', () => {
    // 1,000 NGN per USD, no spread: ₦1,000 is exactly $1 — mid value = credit.
    const priced = price(NGN, USD, '1000', '1', 0, QuoteAmountMode.SOURCE, 100_000n);
    expect(priced.revenueMinor).toBe(0n);
    expect(golden(NGN, USD, priced)).toEqual([
      'USER:source DEBIT 100000 NGN',
      'FX_POSITION CREDIT 100000 NGN',
      'FX_POSITION DEBIT 100 USD',
      'USER:target CREDIT 100 USD',
    ]);
  });

  it('balances per currency for any priced conversion, and never touches EQUITY:ROUNDING', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 15n }),
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 0, max: 300 }),
        fc.boolean(),
        (amount, sourceUsdMillis, spread, targetMode) => {
          const sourceUsd = dec(String(sourceUsdMillis)).div(1000).toFixed();
          const priced = price(NGN, USD, sourceUsd, '1', spread, targetMode ? QuoteAmountMode.TARGET : QuoteAmountMode.SOURCE, amount);
          if (priced.targetAmountMinor === 0n) return;
          const entries = conversionEntries({ source: NGN, target: USD, sourceAccountId: SOURCE_ACCOUNT, targetAccountId: TARGET_ACCOUNT, amounts: priced });
          for (const currency of ['NGN', 'USD']) {
            const sum = (direction: EntryDirection) =>
              entries.filter((e) => e.amount.currency === currency && e.direction === direction).reduce((total, e) => total + e.amount.amountMinor, 0n);
            expect(sum(EntryDirection.DEBIT)).toBe(sum(EntryDirection.CREDIT));
          }
          expect(entries.every((entry) => entry.amount.amountMinor > 0n)).toBe(true);
          expect(entries.some((entry) => 'systemAccount' in entry.account && entry.account.systemAccount === 'EQUITY:ROUNDING')).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('assertConversionAmounts', () => {
  const good: ConversionAmounts = { sourceAmountMinor: 100n, targetAmountMinor: 10n, targetMidValueMinor: 11n, revenueMinor: 1n };

  it('accepts balanced target legs with non-negative revenue', () => {
    expect(codeOf(() => assertConversionAmounts(good))).toBe('OK');
    expect(codeOf(() => assertConversionAmounts({ ...good, targetMidValueMinor: 10n, revenueMinor: 0n }))).toBe('OK');
  });

  it.each([
    ['unbalanced target legs', { ...good, revenueMinor: 2n }],
    ['a zero debit', { ...good, sourceAmountMinor: 0n }],
    ['a zero credit', { ...good, targetAmountMinor: 0n, revenueMinor: 11n }],
    ['a negative revenue', { ...good, targetAmountMinor: 12n, revenueMinor: -1n }],
    ['an amount beyond BIGINT', { ...good, sourceAmountMinor: 2n ** 63n }],
  ])('refuses %s as INVARIANT_VIOLATION (our bug, never the client’s)', (_name, amounts) => {
    expect(() => assertConversionAmounts(amounts)).toThrow(InvariantViolationError);
    expect(() => conversionEntries({ source: NGN, target: USD, sourceAccountId: SOURCE_ACCOUNT, targetAccountId: TARGET_ACCOUNT, amounts })).toThrow(
      InvariantViolationError,
    );
  });
});

describe('rate_display (Phase 7 §D.6): derived from the amounts, asserted before posting', () => {
  it('is target per source in major units, 12 significant digits, plain notation', () => {
    expect(rateDisplayOf(NGN, 100_000n, USD, 74n)).toBe('0.00074');
    expect(rateDisplayOf(USD, 100n, NGN, 130_943n)).toBe('1309.43');
    expect(rateDisplayOf(JPX, 10_000n, KWX, 20_364n)).toBe('0.0020364');
    expect(rateDisplayOf(EUR, 300n, GBP, 100n)).toBe('0.333333333333');
    expect(effectiveRateOf(EUR, 300n, GBP, 100n).toFixed(20)).toBe('0.33333333333333333333');
  });

  it('tolerance is max(1, ⌈target × 10⁻¹¹⌉) target minor units', () => {
    expect(rateDisplayToleranceMinor(1n)).toBe(1n);
    expect(rateDisplayToleranceMinor(100_000_000_000n)).toBe(1n);
    expect(rateDisplayToleranceMinor(100_000_000_001n)).toBe(2n);
    expect(rateDisplayToleranceMinor(10n ** 15n)).toBe(10_000n);
  });

  it('passes when the display reproduces the credit, including at the tolerance boundary', () => {
    expect(codeOf(() => assertRateDisplayReproduces('0.00065011', NGN, 100_000_000n, USD, 65_011n))).toBe('OK');
    // 0.333333333333 × 300 = 99.9999999999 → a gap of 1e-10 minor units: inside.
    expect(codeOf(() => assertRateDisplayReproduces('0.333333333333', EUR, 300n, GBP, 100n))).toBe('OK');
    // Exactly one minor unit off: the boundary is inclusive.
    expect(codeOf(() => assertRateDisplayReproduces('0.00065012', NGN, 100_000_000n, USD, 65_011n))).toBe('OK');
  });

  it('fails loudly when the display and the amounts disagree', () => {
    expect(codeOf(() => assertRateDisplayReproduces('0.00065013', NGN, 100_000_000n, USD, 65_011n))).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(codeOf(() => assertRateDisplayReproduces('0.0007', NGN, 100_000_000n, USD, 65_011n))).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it('for any priced conversion, the derived display reproduces the credit (huge amounts included)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 9n * 10n ** 17n }),
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 0, max: 300 }),
        (amount, sourceUsdMillis, targetUsdMillis, spread) => {
          let priced;
          try {
            priced = price(
              NGN,
              USD,
              dec(String(sourceUsdMillis)).div(1000).toFixed(),
              dec(String(targetUsdMillis)).div(1000).toFixed(),
              spread,
              QuoteAmountMode.SOURCE,
              amount,
            );
          } catch (error) {
            // A credit beyond BIGINT is refused by pricing (AMOUNT_TOO_LARGE at the endpoint).
            if (error instanceof InvalidAmountError) return;
            throw error;
          }
          if (priced.targetAmountMinor === 0n) return;
          const display = rateDisplayOf(NGN, priced.sourceAmountMinor, USD, priced.targetAmountMinor);
          assertRateDisplayReproduces(display, NGN, priced.sourceAmountMinor, USD, priced.targetAmountMinor);
        },
      ),
      { numRuns: 500 },
    );
  });
});
