import { InvariantViolationError } from '../../common/errors';
import { EntryDirection, PostingAuthorization, TransactionType } from '../ledger/ledger.types';
import { validatePostingRequest } from '../ledger/posting/posting-validation';
import { ProviderSettlementBatch, ProviderSettlementLine, ProviderSettlementLineType } from '../payments/payment-provider.port';
import { LineDecision } from './settlement-matcher';
import { buildSettlementPosting, settlementReference } from './settlement-posting';

const ACTIVE = new Set(['NGN', 'USD', 'JPY', 'KWD']);

const line = (lineId: string, type: ProviderSettlementLineType, amountMinor: bigint, feeMinor: bigint, currency = 'NGN'): ProviderSettlementLine => ({
  lineId,
  type,
  paymentId: `pay_${lineId}`,
  chargebackId: type === ProviderSettlementLineType.CHARGEBACK ? `cb_${lineId}` : null,
  currency,
  amountMinor,
  feeMinor,
});

function batchOf(lines: ProviderSettlementLine[], currency = 'NGN', overrides: Partial<ProviderSettlementBatch> = {}): ProviderSettlementBatch {
  const gross = lines.filter((entry) => entry.type === ProviderSettlementLineType.PAYMENT).reduce((sum, entry) => sum + entry.amountMinor, 0n);
  const chargebacks = lines.filter((entry) => entry.type === ProviderSettlementLineType.CHARGEBACK).reduce((sum, entry) => sum + entry.amountMinor, 0n);
  const fees = lines.reduce((sum, entry) => sum + entry.feeMinor, 0n);
  return {
    batchId: 'stl_worked',
    currency,
    status: 'PAID',
    settledAt: new Date('2026-10-01T00:00:00Z'),
    grossMinor: gross,
    feeMinor: fees,
    chargebackMinor: chargebacks,
    netMinor: gross - fees - chargebacks,
    lineCount: lines.length,
    lines,
    providerCallIds: [],
    ...overrides,
  };
}

const decide = (lines: ProviderSettlementLine[], clearing: string[] = []): LineDecision[] =>
  lines.map((entry) => ({
    line: entry,
    attribution: clearing.includes(entry.lineId) ? 'CLEARING' : 'ATTRIBUTED',
    flowId: clearing.includes(entry.lineId) ? null : `flow-${entry.lineId}`,
    discrepancy: null,
  }));

/** `[account, direction, minor]`, the posting's entries. */
const entriesOf = (lines: ProviderSettlementLine[], clearing: string[] = [], currency = 'NGN') =>
  buildSettlementPosting('simulated-psp', batchOf(lines, currency), decide(lines, clearing), ACTIVE).entries.map((entry) => [
    (entry.account as { systemAccount: string }).systemAccount,
    entry.direction,
    entry.amount.amountMinor,
    entry.amount.currency,
  ]);

describe('buildSettlementPosting', () => {
  it('the worked example (plan §E): 3 payments + a chargeback deduction → BANK net, fees, receivable both ways', () => {
    const lines = [
      line('l1', ProviderSettlementLineType.PAYMENT, 1_000_000n, 15_000n),
      line('l2', ProviderSettlementLineType.PAYMENT, 2_500_000n, 37_500n),
      line('l3', ProviderSettlementLineType.PAYMENT, 500_000n, 7_500n),
      line('l4', ProviderSettlementLineType.CHARGEBACK, 800_000n, 150_000n),
    ];
    expect(entriesOf(lines)).toEqual([
      ['BANK', EntryDirection.DEBIT, 2_990_000n, 'NGN'],
      ['EXPENSE:PSP_FEES', EntryDirection.DEBIT, 210_000n, 'NGN'],
      ['PSP_RECEIVABLE', EntryDirection.DEBIT, 800_000n, 'NGN'],
      ['PSP_RECEIVABLE', EntryDirection.CREDIT, 4_000_000n, 'NGN'],
    ]);
  });

  it('the transaction: SETTLEMENT, system-driven, no user, the batch as external reference, value = settlement time', () => {
    const batch = batchOf([line('l1', ProviderSettlementLineType.PAYMENT, 100n, 1n)]);
    const request = buildSettlementPosting('simulated-psp', batch, decide(batch.lines as ProviderSettlementLine[]), ACTIVE);
    expect(request.transaction).toMatchObject({
      type: TransactionType.SETTLEMENT,
      authorization: PostingAuthorization.SYSTEM_DRIVEN,
      valueTime: batch.settledAt,
      settlementTime: batch.settledAt,
      initiatedBy: 'job:reconciliation',
      reference: settlementReference('simulated-psp', 'stl_worked'),
      externalReference: 'stl_worked',
      reasonCode: 'PSP_SETTLEMENT',
    });
    expect(request.transaction.userId).toBeUndefined();
    expect(() => validatePostingRequest(request)).not.toThrow();
  });

  it('unattributed lines go to CLEARING, both ways; attributed ones to the receivable', () => {
    const lines = [
      line('l1', ProviderSettlementLineType.PAYMENT, 1_000n, 10n),
      line('l2', ProviderSettlementLineType.PAYMENT, 500n, 5n),
      line('l3', ProviderSettlementLineType.CHARGEBACK, 200n, 0n),
    ];
    expect(entriesOf(lines, ['l2', 'l3'])).toEqual([
      ['BANK', EntryDirection.DEBIT, 1_285n, 'NGN'],
      ['EXPENSE:PSP_FEES', EntryDirection.DEBIT, 15n, 'NGN'],
      ['CLEARING', EntryDirection.DEBIT, 200n, 'NGN'],
      ['PSP_RECEIVABLE', EntryDirection.CREDIT, 1_000n, 'NGN'],
      ['CLEARING', EntryDirection.CREDIT, 500n, 'NGN'],
    ]);
  });

  it('a zero-fee batch has no fee entry', () => {
    expect(entriesOf([line('l1', ProviderSettlementLineType.PAYMENT, 700n, 0n)])).toEqual([
      ['BANK', EntryDirection.DEBIT, 700n, 'NGN'],
      ['PSP_RECEIVABLE', EntryDirection.CREDIT, 700n, 'NGN'],
    ]);
  });

  it('an all-chargeback batch: the PSP debited us — BANK is CREDITED, recorded, never refused', () => {
    expect(entriesOf([line('l1', ProviderSettlementLineType.CHARGEBACK, 800n, 150n)])).toEqual([
      ['BANK', EntryDirection.CREDIT, 950n, 'NGN'],
      ['EXPENSE:PSP_FEES', EntryDirection.DEBIT, 150n, 'NGN'],
      ['PSP_RECEIVABLE', EntryDirection.DEBIT, 800n, 'NGN'],
    ]);
  });

  it('a payment and its full chargeback in one batch: net 0, no BANK entry, the receivable moves both ways', () => {
    expect(entriesOf([line('l1', ProviderSettlementLineType.PAYMENT, 500n, 0n), line('l2', ProviderSettlementLineType.CHARGEBACK, 500n, 0n)])).toEqual([
      ['PSP_RECEIVABLE', EntryDirection.DEBIT, 500n, 'NGN'],
      ['PSP_RECEIVABLE', EntryDirection.CREDIT, 500n, 'NGN'],
    ]);
  });

  it.each([
    ['JPY', 0, 150_000n, 2_250n],
    ['KWD', 3, 1_234_567n, 18_518n],
  ])('%s (minor unit %i): amounts pass through in minor units, nothing rounded', (currency, _minorUnit, amount, fee) => {
    expect(entriesOf([line('l1', ProviderSettlementLineType.PAYMENT, amount, fee, currency)], [], currency)).toEqual([
      ['BANK', EntryDirection.DEBIT, amount - fee, currency],
      ['EXPENSE:PSP_FEES', EntryDirection.DEBIT, fee, currency],
      ['PSP_RECEIVABLE', EntryDirection.CREDIT, amount, currency],
    ]);
  });

  it('balances per currency for any batch, and each entry is positive', () => {
    const lines = [
      line('l1', ProviderSettlementLineType.PAYMENT, 9_999n, 99n),
      line('l2', ProviderSettlementLineType.CHARGEBACK, 1n, 7n),
      line('l3', ProviderSettlementLineType.PAYMENT, 3n, 0n),
    ];
    const request = buildSettlementPosting('simulated-psp', batchOf(lines), decide(lines, ['l3']), ACTIVE);
    const debit = request.entries.filter((entry) => entry.direction === EntryDirection.DEBIT).reduce((sum, entry) => sum + entry.amount.amountMinor, 0n);
    const credit = request.entries.filter((entry) => entry.direction === EntryDirection.CREDIT).reduce((sum, entry) => sum + entry.amount.amountMinor, 0n);
    expect(debit).toBe(credit);
    for (const entry of request.entries) expect(entry.amount.amountMinor > 0n).toBe(true);
  });

  it('refuses a report whose lines do not add up to its totals, or decisions that do not cover every line', () => {
    const lines = [line('l1', ProviderSettlementLineType.PAYMENT, 100n, 1n)];
    expect(() => buildSettlementPosting('simulated-psp', batchOf(lines, 'NGN', { grossMinor: 101n }), decide(lines), ACTIVE)).toThrow(InvariantViolationError);
    expect(() => buildSettlementPosting('simulated-psp', batchOf(lines, 'NGN', { netMinor: 100n }), decide(lines), ACTIVE)).toThrow(InvariantViolationError);
    expect(() => buildSettlementPosting('simulated-psp', batchOf(lines), [], ACTIVE)).toThrow(InvariantViolationError);
  });

  it('a fee equal to the amount: no BANK entry, still two balanced entries', () => {
    const lines = [line('l1', ProviderSettlementLineType.PAYMENT, 1n, 1n)];
    // fee = amount: BANK 0, fees 1, receivable 1 → still two entries and balanced.
    expect(entriesOf(lines)).toEqual([
      ['EXPENSE:PSP_FEES', EntryDirection.DEBIT, 1n, 'NGN'],
      ['PSP_RECEIVABLE', EntryDirection.CREDIT, 1n, 'NGN'],
    ]);
  });
});
