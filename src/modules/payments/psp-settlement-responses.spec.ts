import { ProviderSettlementLineType } from './payment-provider.port';
import { ProviderResponseInvalidError } from './payment.errors';
import { parseChargebackPage, parsePaymentPage, parseSettlementBatchPage, parseSettlementSummaryPage, sameHeader } from './psp-settlement-responses';

const page = (overrides: Record<string, unknown> = {}, lineOverrides: Record<string, unknown> = {}) => ({
  id: 'stl_1',
  object: 'settlement',
  currency: 'NGN',
  status: 'paid',
  settled_at: '2026-10-01T00:00:00.000Z',
  gross: '1000',
  fees: '15',
  chargebacks: '0',
  net: '985',
  line_count: 1,
  bank_reference: 'BNK123', // a field we do not use: ignored
  lines: {
    data: [{ id: 'l1', type: 'payment', payment_id: 'pay_a', chargeback_id: null, currency: 'NGN', amount: '1000', fee: '15', extra: { nested: true }, ...lineOverrides }],
    next_cursor: null,
  },
  ...overrides,
});

describe('PSP settlement schemas (only the fields we use)', () => {
  it('parses a report page: amounts as bigint from digit strings, unknown fields ignored', () => {
    const parsed = parseSettlementBatchPage(page(), 'get-settlement');
    expect(parsed.header).toEqual({
      batchId: 'stl_1',
      currency: 'NGN',
      status: 'PAID',
      settledAt: new Date('2026-10-01T00:00:00.000Z'),
      grossMinor: 1000n,
      feeMinor: 15n,
      chargebackMinor: 0n,
      netMinor: 985n,
      lineCount: 1,
    });
    expect(parsed.lines).toEqual([
      { lineId: 'l1', type: ProviderSettlementLineType.PAYMENT, paymentId: 'pay_a', chargebackId: null, currency: 'NGN', amountMinor: 1000n, feeMinor: 15n },
    ]);
    expect(parsed.nextCursor).toBeNull();
  });

  it('a negative net is allowed (the PSP debited us); a negative amount is not', () => {
    expect(parseSettlementBatchPage(page({ net: '-150' }), 'op').header.netMinor).toBe(-150n);
    expect(() => parseSettlementBatchPage(page({ gross: '-1' }), 'op')).toThrow(ProviderResponseInvalidError);
  });

  it.each([
    ['an amount as a JSON number', page({ gross: 1000 })],
    ['a line amount as a JSON number', page({}, { amount: 1000 })],
    ['a fee as a JSON number', page({}, { fee: 15 })],
    ['a decimal amount', page({ fees: '15.5' })],
    ['an unknown line type', page({}, { type: 'refund' })],
    ['a chargeback line without its chargeback id', page({}, { type: 'chargeback' })],
    ['a payment line carrying a chargeback id', page({}, { chargeback_id: 'cb_1' })],
    ['a missing settled_at', page({ settled_at: undefined })],
    ['a lowercase currency', page({ currency: 'ngn' })],
    ['an unknown status', page({ status: 'settled' })],
  ])('refuses %s (fails loudly; nothing enters the system)', (_name, body) => {
    expect(() => parseSettlementBatchPage(body, 'get-settlement')).toThrow(ProviderResponseInvalidError);
  });

  it('parses the settlement list and the payment list pages with their cursors', () => {
    expect(
      parseSettlementSummaryPage({ data: [{ id: 'stl_1', currency: 'NGN', status: 'pending', settled_at: '2026-10-01T00:00:00Z', noise: 1 }], next_cursor: 'abc' }, 'list'),
    ).toEqual({ items: [{ batchId: 'stl_1', currency: 'NGN', status: 'PENDING', settledAt: new Date('2026-10-01T00:00:00Z') }], nextCursor: 'abc' });
    const payments = parsePaymentPage(
      { data: [{ id: 'pay_a', reference: 'ref', status: 'captured', amount: '100', currency: 'NGN', captured_at: '2026-10-01T00:00:00Z' }] },
      'list-payments',
    );
    expect(payments.items[0].paymentId).toBe('pay_a');
    expect(payments.nextCursor).toBeNull();
    expect(() => parsePaymentPage({ data: 'nope' }, 'list-payments')).toThrow(ProviderResponseInvalidError);
  });

  it('parses the chargeback list (by the dispute’s own date); a numeric amount is refused', () => {
    const parsed = parseChargebackPage(
      { data: [{ id: 'cb_1', payment_id: 'pay_a', amount: '800', currency: 'NGN', created_at: '2026-12-01T00:00:00Z', reason: 'fraudulent' }], next_cursor: null },
      'list-chargebacks',
    );
    expect(parsed.items[0]).toMatchObject({ chargebackId: 'cb_1', paymentId: 'pay_a', createdAt: new Date('2026-12-01T00:00:00Z') });
    expect(parsed.items[0].amount.toMinorString()).toBe('800');
    expect(() =>
      parseChargebackPage({ data: [{ id: 'cb_1', payment_id: 'pay_a', amount: 800, currency: 'NGN', created_at: '2026-12-01T00:00:00Z' }] }, 'list-chargebacks'),
    ).toThrow(ProviderResponseInvalidError);
  });

  it('two pages of one report must agree on the header', () => {
    const header = parseSettlementBatchPage(page(), 'op').header;
    expect(sameHeader(header, { ...header })).toBe(true);
    expect(sameHeader(header, { ...header, feeMinor: 16n })).toBe(false);
    expect(sameHeader(header, { ...header, settledAt: new Date(0) })).toBe(false);
  });
});
