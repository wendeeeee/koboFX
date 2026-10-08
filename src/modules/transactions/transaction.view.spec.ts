import { ErrorCode } from '../../common/errors';
import { HISTORY_TYPES, PUBLIC_REASON_CODES, initiatorOf, statusOfTransaction, statusOfUnpostedFunding, statusOfUnpostedWithdrawal } from './history-status';
import { HistoryRow, detailView, listItemView } from './transaction.view';

const AT = new Date('2026-09-29T10:00:00.123Z');

function row(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    source: 'TRANSACTION',
    id: 'a0000000-0000-4000-8000-000000000001',
    position_microseconds: '1790676000123456',
    reference: 'conversion:b0000000-0000-4000-8000-000000000001',
    type: 'CONVERSION',
    status: 'POSTED',
    reason_code: 'QUOTED_TRADE',
    initiated_by: 'user:c0000000-0000-4000-8000-000000000001',
    failure_code: null,
    value_time: AT,
    booking_time: AT,
    settlement_time: null,
    rate_display: '0.000650110000',
    reference_rate: '0.00065338124837365',
    rate_provider: 'exchange-rate-api',
    rate_fetched_at: new Date('2026-09-29T09:59:00Z'),
    rate_provider_updated_at: new Date('2026-09-29T09:58:00Z'),
    rate_snapshot_id: 'd0000000-0000-4000-8000-000000000001',
    spread_basis_points: 50,
    quote_id: 'e0000000-0000-4000-8000-000000000001',
    corrects_transaction_id: null,
    corrected_by_transaction_id: null,
    corrects_reference: null,
    corrects_type: null,
    corrected_by_reference: null,
    corrected_by_type: null,
    legs: [
      { currency: 'NGN', minorUnit: 2, direction: 'DEBIT', amount: '100000000', balanceAfter: '0' },
      { currency: 'USD', minorUnit: 2, direction: 'CREDIT', amount: '65011', balanceAfter: '65011' },
    ],
    requested_currency: null,
    requested_minor_unit: null,
    requested_amount: null,
    ...overrides,
  };
}

/** Every key anywhere in a value (to prove something is absent, not merely undefined at the top). */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
  return [];
}

describe('history views', () => {
  it('a conversion: minor-unit strings, stored rates formatted for display (12 significant digits), full provenance on the detail', () => {
    const detail = detailView(row());
    expect(detail).toEqual({
      reference: 'conversion:b0000000-0000-4000-8000-000000000001',
      type: 'CONVERSION',
      status: 'COMPLETED',
      reasonCode: 'QUOTED_TRADE',
      legs: [
        { currency: 'NGN', minorUnit: 2, direction: 'DEBIT', amount: '100000000', balanceAfter: '0' },
        { currency: 'USD', minorUnit: 2, direction: 'CREDIT', amount: '65011', balanceAfter: '65011' },
      ],
      requested: null,
      rate: {
        rateDisplay: '0.00065011',
        quoteId: 'e0000000-0000-4000-8000-000000000001',
        referenceRate: '0.000653381248374',
        spreadBasisPoints: 50,
        provider: 'exchange-rate-api',
        asOf: '2026-09-29T09:58:00.000Z',
        fetchedAt: '2026-09-29T09:59:00.000Z',
        snapshotId: 'd0000000-0000-4000-8000-000000000001',
      },
      failureCode: null,
      valueTime: '2026-09-29T10:00:00.123Z',
      bookingTime: '2026-09-29T10:00:00.123Z',
      corrects: null,
      correctedBy: null,
      settlementTime: null,
      initiatedBy: 'USER',
    });
  });

  it('the list item is the detail minus balances and provenance', () => {
    const item = listItemView(row());
    expect(item.legs).toEqual([
      { currency: 'NGN', minorUnit: 2, direction: 'DEBIT', amount: '100000000' },
      { currency: 'USD', minorUnit: 2, direction: 'CREDIT', amount: '65011' },
    ]);
    expect(item.rate).toEqual({ rateDisplay: '0.00065011', quoteId: 'e0000000-0000-4000-8000-000000000001' });
    expect(keysOf(item)).not.toEqual(expect.arrayContaining(['balanceAfter']));
    expect(Object.keys(item)).not.toEqual(expect.arrayContaining(['initiatedBy', 'settlementTime']));
  });

  it('never shows revenue, mid value, metadata, external references or identities', () => {
    const keys = [...keysOf(detailView(row())), ...keysOf(listItemView(row()))];
    for (const hidden of ['revenue', 'revenueMinor', 'midValue', 'midValueMinor', 'metadata', 'externalReference', 'userId', 'id', 'transactionId', 'accountId']) {
      expect(keys).not.toContain(hidden);
    }
    expect(JSON.stringify(detailView(row()))).not.toContain('c0000000-0000-4000-8000-000000000001');
  });

  it('JPY (0) and KWD (3) keep their minor units; amounts stay strings beyond 2^53', () => {
    const detail = detailView(
      row({
        rate_display: null,
        type: 'FUNDING',
        legs: [
          { currency: 'JPY', minorUnit: 0, direction: 'CREDIT', amount: '9007199254740993', balanceAfter: '9007199254740993' },
          { currency: 'KWD', minorUnit: 3, direction: 'DEBIT', amount: '1', balanceAfter: '-1' },
        ],
      }),
    );
    expect(detail.legs.map((leg) => [leg.minorUnit, leg.amount])).toEqual([
      [0, '9007199254740993'],
      [3, '1'],
    ]);
    expect(detail.rate).toBeNull();
  });

  it('corrections both ways', () => {
    const original = detailView(
      row({ status: 'REVERSED', corrected_by_transaction_id: 'x', corrected_by_reference: 'chargeback:1', corrected_by_type: 'REVERSAL', rate_display: null }),
    );
    expect(original).toMatchObject({ status: 'REVERSED', corrects: null, correctedBy: { reference: 'chargeback:1', type: 'REVERSAL' } });
    const reversal = detailView(row({ type: 'REVERSAL', corrects_transaction_id: 'y', corrects_reference: 'funding:1', corrects_type: 'FUNDING', rate_display: null }));
    expect(reversal).toMatchObject({ status: 'COMPLETED', corrects: { reference: 'funding:1', type: 'FUNDING' }, correctedBy: null });
  });

  it('a link the caller-scoped join did not return fails loudly (never "no link")', () => {
    expect(() => detailView(row({ corrects_transaction_id: 'y', corrects_reference: null, corrects_type: null }))).toThrow(
      expect.objectContaining({ code: ErrorCode.INVARIANT_VIOLATION }),
    );
    expect(() => detailView(row({ corrected_by_transaction_id: 'y', corrected_by_reference: 'r', corrected_by_type: null }))).toThrow(
      expect.objectContaining({ code: ErrorCode.INVARIANT_VIOLATION }),
    );
  });

  it('a rate with incomplete provenance fails loudly', () => {
    for (const missing of ['reference_rate', 'rate_provider', 'rate_fetched_at', 'rate_provider_updated_at', 'rate_snapshot_id', 'spread_basis_points'] as const) {
      expect(() => detailView(row({ [missing]: null }))).toThrow(expect.objectContaining({ code: ErrorCode.INVARIANT_VIOLATION }));
    }
  });

  it('a funding that never posted: its request, no legs, PENDING or FAILED', () => {
    const unposted = row({
      source: 'FUNDING',
      reference: 'funding:f0000000-0000-4000-8000-000000000001',
      type: 'FUNDING',
      status: 'FAILED',
      reason_code: null,
      failure_code: 'CARD_DECLINED',
      rate_display: null,
      legs: null,
      requested_currency: 'NGN',
      requested_minor_unit: 2,
      requested_amount: '150000',
    });
    expect(listItemView(unposted)).toMatchObject({
      status: 'FAILED',
      legs: [],
      requested: { currency: 'NGN', minorUnit: 2, amount: '150000' },
      failureCode: 'CARD_DECLINED',
      rate: null,
    });
    expect(listItemView({ ...unposted, status: 'AUTHORIZED', failure_code: null }).status).toBe('PENDING');
    expect(() => listItemView({ ...unposted, requested_amount: null })).toThrow(expect.objectContaining({ code: ErrorCode.INVARIANT_VIOLATION }));
  });

  it('a withdrawal that never posted: its principal requested, no legs; status by the WITHDRAWAL table, not funding\'s', () => {
    const unposted = row({
      source: 'WITHDRAWAL',
      reference: 'withdrawal:f0000000-0000-4000-8000-000000000002',
      type: 'WITHDRAWAL',
      status: 'PROCESSING',
      reason_code: null,
      rate_display: null,
      legs: null,
      requested_currency: 'NGN',
      requested_minor_unit: 2,
      requested_amount: '80000',
    });
    expect(detailView(unposted)).toMatchObject({
      reference: 'withdrawal:f0000000-0000-4000-8000-000000000002',
      type: 'WITHDRAWAL',
      status: 'PENDING',
      legs: [],
      requested: { currency: 'NGN', minorUnit: 2, amount: '80000' },
      settlementTime: null,
      initiatedBy: 'USER',
    });
    expect(listItemView({ ...unposted, status: 'FAILED', failure_code: 'TRANSFER_FAILED' })).toMatchObject({ status: 'FAILED', failureCode: 'TRANSFER_FAILED' });
    // A funding state is not a withdrawal state (and vice versa): each source has its own table.
    expect(() => listItemView({ ...unposted, status: 'AUTHORIZED' })).toThrow(expect.objectContaining({ code: ErrorCode.INVARIANT_VIOLATION }));
    expect(() => listItemView({ ...unposted, source: 'FUNDING', status: 'PROCESSING' })).toThrow(expect.objectContaining({ code: ErrorCode.INVARIANT_VIOLATION }));
    expect(() => listItemView({ ...unposted, status: 'POSTED' })).toThrow(expect.objectContaining({ code: ErrorCode.INVARIANT_VIOLATION }));
  });
});

describe('history status and initiator', () => {
  it('one wire vocabulary', () => {
    expect(['POSTED', 'REVERSED', 'PENDING', 'FAILED'].map(statusOfTransaction)).toEqual(['COMPLETED', 'REVERSED', 'PENDING', 'FAILED']);
    expect(() => statusOfTransaction('SETTLED')).toThrow(expect.objectContaining({ code: ErrorCode.INVARIANT_VIOLATION }));
    expect(['INITIATED', 'AUTHORIZED', 'CAPTURED', 'FAILED'].map(statusOfUnpostedFunding)).toEqual(['PENDING', 'PENDING', 'PENDING', 'FAILED']);
    // A funding with a transaction is never "unposted".
    for (const state of ['POSTED', 'SETTLED', 'REVERSED', 'NONSENSE']) {
      expect(() => statusOfUnpostedFunding(state)).toThrow(expect.objectContaining({ code: ErrorCode.INVARIANT_VIOLATION }));
    }
    // An unposted withdrawal: held money is PENDING, a failure before posting is FAILED; a posted one is never unposted.
    expect(['RESERVED', 'SUBMITTING', 'PROCESSING', 'FAILED'].map(statusOfUnpostedWithdrawal)).toEqual(['PENDING', 'PENDING', 'PENDING', 'FAILED']);
    for (const state of ['POSTED', 'REVERSED', 'INITIATED', 'NONSENSE']) {
      expect(() => statusOfUnpostedWithdrawal(state)).toThrow(expect.objectContaining({ code: ErrorCode.INVARIANT_VIOLATION }));
    }
  });

  it('initiators without identities', () => {
    expect(initiatorOf('user:abc')).toBe('USER');
    expect(initiatorOf('job:funding-flow')).toBe('SYSTEM');
    expect(initiatorOf('operator:staff-7')).toBe('OPERATOR');
    expect(() => initiatorOf('robot:1')).toThrow(expect.objectContaining({ code: ErrorCode.INVARIANT_VIOLATION }));
  });

  it('pins the public reason codes and filterable types (renaming one is a breaking change)', () => {
    expect(PUBLIC_REASON_CODES).toEqual([
      'CARD_DEPOSIT',
      'CHARGEBACK',
      'MARKET_CONVERSION',
      'QUOTED_TRADE',
      'SIGNUP_DEMO_CREDIT',
      'CLEARING_REATTRIBUTION',
      'SETTLEMENT_AMOUNT_CORRECTION',
      'PARTIAL_CHARGEBACK',
      'WRITE_OFF',
      'PAYSTACK_WITHDRAWAL',
      'PAYSTACK_TRANSFER_REVERSED',
    ]);
    expect(HISTORY_TYPES).toEqual(['FUNDING', 'CONVERSION', 'WITHDRAWAL', 'REVERSAL', 'CORRECTION', 'PROMOTIONAL', 'WRITE_OFF']);
  });
});
