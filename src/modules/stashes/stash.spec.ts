import { ErrorCode } from '../../common/errors';
import { decodeStashCursor, encodeStashCursor } from './stash-cursor';
import { ReceiptRow, receiptView } from './stash.service';

const ID = 'a0000000-0000-4000-8000-000000000001';
const WITHDRAWAL = 'b0000000-0000-4000-8000-000000000002';

function row(overrides: Partial<ReceiptRow> = {}): ReceiptRow {
  return {
    id: ID,
    position_microseconds: '1790676000123456',
    event_kind: 'CONFIRMATION',
    currency_code: 'NGN',
    minor_unit: 2,
    amount_minor: '9223372036854775807',
    withdrawal_id: WITHDRAWAL,
    provider_reference: `withdrawal-${WITHDRAWAL}`,
    ledger_reference: `withdrawal:${WITHDRAWAL}`,
    bank_code: '058',
    bank_name: 'Guaranty Trust Bank',
    account_number_last_four: '6789',
    reverses_receipt_id: null,
    reversed_by_receipt_id: null,
    value_time: new Date('2026-10-01T10:00:00.123Z'),
    recorded_at: new Date('2026-10-01T10:00:01.456Z'),
    ...overrides,
  };
}

const invariant = expect.objectContaining({ code: ErrorCode.INVARIANT_VIOLATION });
const invalidCursor = expect.objectContaining({ code: ErrorCode.INVALID_CURSOR });

describe('stash cursor', () => {
  it('round-trips microseconds exactly (beyond 2^53) and the id', () => {
    const position = { timeMicroseconds: 1_790_676_000_123_457n, id: ID };
    expect(decodeStashCursor(encodeStashCursor(position, 'NGN'), 'NGN')).toEqual(position);
    expect(decodeStashCursor(encodeStashCursor(position, null), null)).toEqual(position);
  });

  it('is bound to the currency filter it was issued under', () => {
    const cursor = encodeStashCursor({ timeMicroseconds: 1n, id: ID }, 'NGN');
    expect(() => decodeStashCursor(cursor, null)).toThrow(invalidCursor);
    expect(() => decodeStashCursor(cursor, 'USD')).toThrow(invalidCursor);
  });

  it.each([
    ['empty', ''],
    ['too long', 'a'.repeat(257)],
    ['not base64url', 'not a cursor'],
    ['not JSON', Buffer.from('{').toString('base64url')],
    ['an array', Buffer.from('[]').toString('base64url')],
    ['an extra key', Buffer.from(JSON.stringify({ v: 1, t: '1', i: ID, c: null, x: 1 })).toString('base64url')],
    ['another version', Buffer.from(JSON.stringify({ v: 2, t: '1', i: ID, c: null })).toString('base64url')],
    ['a negative time', Buffer.from(JSON.stringify({ v: 1, t: '-1', i: ID, c: null })).toString('base64url')],
    ['a number time', Buffer.from(JSON.stringify({ v: 1, t: 1, i: ID, c: null })).toString('base64url')],
    ['an upper-case id', Buffer.from(JSON.stringify({ v: 1, t: '1', i: ID.toUpperCase(), c: null })).toString('base64url')],
  ])('refuses %s', (_name, cursor) => {
    expect(() => decodeStashCursor(cursor, null)).toThrow(invalidCursor);
  });
});

describe('stash receipt view', () => {
  it('a confirmation: IN, positive principal string (exact beyond 2^53), masked destination, both references', () => {
    expect(receiptView(row())).toEqual({
      receiptId: ID,
      kind: 'CONFIRMATION',
      direction: 'IN',
      currency: 'NGN',
      minorUnit: 2,
      amount: '9223372036854775807',
      withdrawalId: WITHDRAWAL,
      withdrawalReference: `withdrawal:${WITHDRAWAL}`,
      providerReference: `withdrawal-${WITHDRAWAL}`,
      ledgerReference: `withdrawal:${WITHDRAWAL}`,
      destination: { bankCode: '058', bankName: 'Guaranty Trust Bank', accountNumberMasked: '******6789' },
      reversesReceiptId: null,
      reversedByReceiptId: null,
      valueTime: '2026-10-01T10:00:00.123Z',
      recordedAt: '2026-10-01T10:00:01.456Z',
    });
  });

  it('a reversal: OUT, linked to the confirmation it reverses', () => {
    const confirmation = 'c0000000-0000-4000-8000-000000000003';
    expect(receiptView(row({ event_kind: 'REVERSAL', reverses_receipt_id: confirmation, ledger_reference: `withdrawal-reversal:${WITHDRAWAL}` }))).toMatchObject({
      kind: 'REVERSAL',
      direction: 'OUT',
      reversesReceiptId: confirmation,
      reversedByReceiptId: null,
      ledgerReference: `withdrawal-reversal:${WITHDRAWAL}`,
    });
  });

  it('broken facts fail loudly, never a guessed receipt', () => {
    expect(() => receiptView(row({ event_kind: 'REFUND' }))).toThrow(invariant);
    expect(() => receiptView(row({ event_kind: 'REVERSAL' }))).toThrow(invariant);
    expect(() => receiptView(row({ event_kind: 'REVERSAL', reverses_receipt_id: ID, reversed_by_receipt_id: ID }))).toThrow(invariant);
    // The receipt's posting not visible as the owner's: never dropped, never shown with another reference.
    expect(() => receiptView(row({ ledger_reference: null }))).toThrow(invariant);
  });

  it('never carries the account number, the account name or provider recipient identifiers', () => {
    const keys = JSON.stringify(receiptView(row()));
    for (const forbidden of ['accountNumber"', 'accountName', 'recipient', 'transferCode', 'transferId']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
