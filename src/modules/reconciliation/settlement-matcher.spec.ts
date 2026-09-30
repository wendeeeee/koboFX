import fc from 'fast-check';
import { ProviderSettlementBatch, ProviderSettlementLine, ProviderSettlementLineType } from '../payments/payment-provider.port';
import { BreakType } from './break-types';
import {
  KnownDeposit,
  MatchInput,
  MatchResult,
  PaymentLookup,
  SettlementRejection,
  lockedPeriodDiscrepancy,
  matchSettlementBatch,
  settlementContentHash,
  validateSettlementReport,
} from './settlement-matcher';

const PROVIDER = 'simulated-psp';
const ACTIVE = new Set(['NGN', 'USD', 'JPY', 'KWD']);

function payment(lineId: string, paymentId: string, amountMinor: bigint, feeMinor = 0n, currency = 'NGN'): ProviderSettlementLine {
  return { lineId, type: ProviderSettlementLineType.PAYMENT, paymentId, chargebackId: null, currency, amountMinor, feeMinor };
}

function chargeback(lineId: string, paymentId: string, chargebackId: string, amountMinor: bigint, feeMinor = 0n, currency = 'NGN'): ProviderSettlementLine {
  return { lineId, type: ProviderSettlementLineType.CHARGEBACK, paymentId, chargebackId, currency, amountMinor, feeMinor };
}

/** A report whose totals are computed from its lines (the honest PSP). */
function batchOf(lines: ProviderSettlementLine[], overrides: Partial<ProviderSettlementBatch> = {}): ProviderSettlementBatch {
  const gross = lines.filter((line) => line.type === ProviderSettlementLineType.PAYMENT).reduce((sum, line) => sum + line.amountMinor, 0n);
  const chargebacks = lines.filter((line) => line.type === ProviderSettlementLineType.CHARGEBACK).reduce((sum, line) => sum + line.amountMinor, 0n);
  const fees = lines.reduce((sum, line) => sum + line.feeMinor, 0n);
  return {
    batchId: 'stl_1',
    currency: 'NGN',
    status: 'PAID',
    settledAt: new Date('2026-10-01T00:00:00Z'),
    grossMinor: gross,
    feeMinor: fees,
    chargebackMinor: chargebacks,
    netMinor: gross - fees - chargebacks,
    lineCount: lines.length,
    lines,
    providerCallIds: ['1'],
    ...overrides,
  };
}

function deposit(flowId: string, paymentId: string, amountMinor: bigint, overrides: Partial<KnownDeposit> = {}): KnownDeposit {
  return { flowId, providerPaymentId: paymentId, currency: 'NGN', amountMinor, posted: true, ...overrides };
}

function input(batch: ProviderSettlementBatch, deposits: KnownDeposit[], extra: Partial<MatchInput> = {}): MatchInput {
  return {
    provider: PROVIDER,
    batch,
    deposits: new Map(deposits.map((entry) => [entry.providerPaymentId, entry])),
    settledPaymentIds: new Set(),
    deductedChargebackIds: new Set(),
    lookups: new Map<string, PaymentLookup>(),
    activeCurrencies: ACTIVE,
    ...extra,
  };
}

function accepted(result: MatchResult) {
  if (result.kind !== 'ACCEPTED') throw new Error(`expected ACCEPTED, got ${JSON.stringify(result)}`);
  return result.lines;
}

describe('matchSettlementBatch', () => {
  it('one batch, many deposits: every line attributed to its own flow, no discrepancy (one-to-many)', () => {
    const batch = batchOf([payment('l1', 'pay_a', 1_000_000n, 15_000n), payment('l2', 'pay_b', 2_500_000n, 37_500n), payment('l3', 'pay_c', 500_000n, 7_500n)]);
    const lines = accepted(
      matchSettlementBatch(input(batch, [deposit('f-a', 'pay_a', 1_000_000n), deposit('f-b', 'pay_b', 2_500_000n), deposit('f-c', 'pay_c', 500_000n)])),
    );
    expect(lines.map((line) => [line.line.paymentId, line.attribution, line.flowId, line.discrepancy])).toEqual([
      ['pay_a', 'ATTRIBUTED', 'f-a', null],
      ['pay_b', 'ATTRIBUTED', 'f-b', null],
      ['pay_c', 'ATTRIBUTED', 'f-c', null],
    ]);
  });

  it('matches on the PSP id, never on amount: a line naming another payment with the same amount is not ours', () => {
    const batch = batchOf([payment('l1', 'pay_other', 1_000_000n)]);
    const lines = accepted(matchSettlementBatch(input(batch, [deposit('f-a', 'pay_a', 1_000_000n)], { lookups: new Map([['pay_other', { kind: 'UNKNOWN' }]]) })));
    expect(lines[0].attribution).toBe('CLEARING');
    expect(lines[0].discrepancy?.type).toBe(BreakType.UNATTRIBUTED_SETTLEMENT_LINE);
  });

  it.each([
    ['UNATTRIBUTED_SETTLEMENT_LINE (the PSP 404s its own line)', [] as KnownDeposit[], { kind: 'UNKNOWN' } as PaymentLookup, BreakType.UNATTRIBUTED_SETTLEMENT_LINE, `line:${PROVIDER}:stl_1:l1`],
    ['PAYMENT_WITHOUT_FLOW (a payment we never saw)', [], { kind: 'FOREIGN', reference: 'someone-else' } as PaymentLookup, BreakType.PAYMENT_WITHOUT_FLOW, `payment:${PROVIDER}:pay_x`],
    ['AMOUNT_MISMATCH', [deposit('f-x', 'pay_x', 999_999n)], undefined, BreakType.AMOUNT_MISMATCH, `payment:${PROVIDER}:pay_x`],
    ['CURRENCY_MISMATCH', [deposit('f-x', 'pay_x', 1_000_000n, { currency: 'USD' })], undefined, BreakType.CURRENCY_MISMATCH, `payment:${PROVIDER}:pay_x`],
    ['MISSING_IN_LEDGER (a deposit the PSP paid out that we never booked)', [deposit('f-x', 'pay_x', 1_000_000n, { posted: false })], undefined, BreakType.MISSING_IN_LEDGER, `payment:${PROVIDER}:pay_x`],
  ])('%s: exactly one discrepancy, money to CLEARING', (_name, deposits, lookup, type, subject) => {
    const batch = batchOf([payment('l1', 'pay_x', 1_000_000n, 1_000n)]);
    const lookups = new Map<string, PaymentLookup>(lookup ? [['pay_x', lookup]] : []);
    const lines = accepted(matchSettlementBatch(input(batch, deposits, { lookups })));
    expect(lines).toHaveLength(1);
    expect(lines[0].attribution).toBe('CLEARING');
    expect(lines[0].discrepancy).toMatchObject({ type, subjectKey: subject, currency: 'NGN', amountMinor: 1_000_000n, providerLineId: 'l1' });
  });

  it('DUPLICATE_SETTLEMENT_LINE: a payment an earlier batch settled, or twice in this batch — the repeat goes to CLEARING', () => {
    const earlier = accepted(
      matchSettlementBatch(input(batchOf([payment('l1', 'pay_a', 100n)]), [deposit('f-a', 'pay_a', 100n)], { settledPaymentIds: new Set(['pay_a']) })),
    );
    expect(earlier[0]).toMatchObject({ attribution: 'CLEARING', flowId: 'f-a' });
    expect(earlier[0].discrepancy?.type).toBe(BreakType.DUPLICATE_SETTLEMENT_LINE);

    const twice = accepted(matchSettlementBatch(input(batchOf([payment('l2', 'pay_a', 100n), payment('l1', 'pay_a', 100n)]), [deposit('f-a', 'pay_a', 100n)])));
    expect(twice.map((line) => [line.line.lineId, line.attribution, line.discrepancy?.type ?? null])).toEqual([
      ['l1', 'ATTRIBUTED', null],
      ['l2', 'CLEARING', BreakType.DUPLICATE_SETTLEMENT_LINE],
    ]);
  });

  it('chargebacks: a full deduction is attributed; a partial one is the flow’s CHARGEBACK_NOT_REVERSED (partial); a repeat is a duplicate', () => {
    const full = accepted(matchSettlementBatch(input(batchOf([chargeback('l1', 'pay_z', 'cb_1', 800_000n, 150_000n)]), [deposit('f-z', 'pay_z', 800_000n)])));
    expect(full[0]).toMatchObject({ attribution: 'ATTRIBUTED', flowId: 'f-z', discrepancy: null });

    const partial = accepted(matchSettlementBatch(input(batchOf([chargeback('l1', 'pay_z', 'cb_1', 300_000n)]), [deposit('f-z', 'pay_z', 800_000n)])));
    expect(partial[0].attribution).toBe('CLEARING');
    expect(partial[0].discrepancy).toMatchObject({ type: BreakType.CHARGEBACK_NOT_REVERSED, subjectKey: 'flow:f-z', details: expect.objectContaining({ partial: true }) });

    const repeated = accepted(
      matchSettlementBatch(input(batchOf([chargeback('l1', 'pay_z', 'cb_1', 800_000n)]), [deposit('f-z', 'pay_z', 800_000n)], { deductedChargebackIds: new Set(['cb_1']) })),
    );
    expect(repeated[0].discrepancy?.type).toBe(BreakType.DUPLICATE_SETTLEMENT_LINE);
  });

  it.each([
    ['totals that do not add up', batchOf([payment('l1', 'pay_a', 100n)], { grossMinor: 101n }), SettlementRejection.TOTALS_MISMATCH],
    ['a net that is not gross − fees − chargebacks', batchOf([payment('l1', 'pay_a', 100n, 1n)], { netMinor: 100n }), SettlementRejection.TOTALS_MISMATCH],
    ['a fee total that is not the lines’', batchOf([payment('l1', 'pay_a', 100n, 1n)], { feeMinor: 2n, netMinor: 98n }), SettlementRejection.TOTALS_MISMATCH],
    ['a line in another currency', batchOf([payment('l1', 'pay_a', 100n, 0n, 'USD')]), SettlementRejection.MIXED_CURRENCY],
    ['fewer lines than stated', batchOf([payment('l1', 'pay_a', 100n)], { lineCount: 2 }), SettlementRejection.LINE_COUNT_MISMATCH],
    ['a repeated line id', batchOf([payment('l1', 'pay_a', 100n), payment('l1', 'pay_b', 100n)]), SettlementRejection.DUPLICATE_LINE_ID],
    ['a currency we do not hold', batchOf([payment('l1', 'pay_a', 100n, 0n, 'CHF')], { currency: 'CHF' }), SettlementRejection.UNSUPPORTED_CURRENCY],
    ['a zero-amount line', batchOf([payment('l1', 'pay_a', 0n)]), SettlementRejection.INVALID_LINE_AMOUNT],
  ])('refuses a report with %s: nothing matched, one SETTLEMENT_REPORT_REJECTED', (_name, batch, code) => {
    const result = matchSettlementBatch(input(batch, [deposit('f-a', 'pay_a', 100n)]));
    expect(result).toMatchObject({ kind: 'REJECTED', code, discrepancy: { type: BreakType.SETTLEMENT_REPORT_REJECTED, subjectKey: `batch:${PROVIDER}:stl_1` } });
  });

  it('an empty batch is refused without a break (nothing moved)', () => {
    expect(matchSettlementBatch(input(batchOf([]), []))).toEqual({ kind: 'REJECTED', code: SettlementRejection.EMPTY, discrepancy: null });
    expect(validateSettlementReport(batchOf([payment('l1', 'pay_a', 100n)]), ACTIVE)).toBeNull();
  });

  it('a locked period becomes SETTLEMENT_IN_LOCKED_PERIOD with the absolute net', () => {
    const batch = batchOf([chargeback('l1', 'pay_z', 'cb_1', 800n, 10n)]);
    expect(lockedPeriodDiscrepancy(PROVIDER, batch)).toMatchObject({ type: BreakType.SETTLEMENT_IN_LOCKED_PERIOD, amountMinor: 810n });
  });

  it('is deterministic and idempotent: the same inputs, in any line order, give the same decisions', () => {
    const lineArbitrary = fc.record({
      paymentIndex: fc.integer({ min: 0, max: 5 }),
      amount: fc.bigInt({ min: 1n, max: 10_000n }),
      fee: fc.bigInt({ min: 0n, max: 100n }),
      kind: fc.constantFrom(ProviderSettlementLineType.PAYMENT, ProviderSettlementLineType.CHARGEBACK),
    });
    fc.assert(
      fc.property(fc.array(lineArbitrary, { minLength: 1, maxLength: 12 }), fc.boolean(), (drafts, reverse) => {
        const lines = drafts.map((draft, index) =>
          draft.kind === ProviderSettlementLineType.PAYMENT
            ? payment(`l${String(index).padStart(2, '0')}`, `pay_${draft.paymentIndex}`, draft.amount, draft.fee)
            : chargeback(`l${String(index).padStart(2, '0')}`, `pay_${draft.paymentIndex}`, `cb_${draft.paymentIndex}`, draft.amount, draft.fee),
        );
        const deposits = [0, 1, 2].map((index) => deposit(`f-${index}`, `pay_${index}`, 5_000n));
        const first = matchSettlementBatch(input(batchOf(lines), deposits));
        const second = matchSettlementBatch(input(batchOf(reverse ? [...lines].reverse() : lines), deposits));
        expect(second).toEqual(first);
        // Every line has exactly one decision; ATTRIBUTED ⇔ no discrepancy.
        const decisions = accepted(first);
        expect(decisions).toHaveLength(lines.length);
        for (const decision of decisions) expect(decision.attribution === 'ATTRIBUTED').toBe(decision.discrepancy === null);
        // A payment id is attributed at most once.
        const attributedPayments = decisions.filter((d) => d.attribution === 'ATTRIBUTED' && d.line.type === ProviderSettlementLineType.PAYMENT).map((d) => d.line.paymentId);
        expect(new Set(attributedPayments).size).toBe(attributedPayments.length);
      }),
      { numRuns: 200 },
    );
  });
});

describe('settlementContentHash', () => {
  it('is the same for the same report in any line order, and different for any changed field', () => {
    const lines = [payment('l1', 'pay_a', 100n, 1n), chargeback('l2', 'pay_b', 'cb_1', 50n)];
    const base = batchOf(lines);
    expect(settlementContentHash(batchOf([...lines].reverse()))).toBe(settlementContentHash(base));
    expect(settlementContentHash(base)).toMatch(/^[0-9a-f]{64}$/);
    const changed = [
      batchOf([payment('l1', 'pay_a', 100n, 2n), lines[1]]),
      batchOf(lines, { settledAt: new Date('2026-10-02T00:00:00Z') }),
      batchOf(lines, { batchId: 'stl_2' }),
      batchOf([payment('l1', 'pay_c', 100n, 1n), lines[1]]),
    ];
    for (const other of changed) expect(settlementContentHash(other)).not.toBe(settlementContentHash(base));
  });
});
