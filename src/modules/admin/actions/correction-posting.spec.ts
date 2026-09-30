import fc from 'fast-check';
import { Money } from '../../../common/money';
import { EntryDirection, LedgerEntryDraft } from '../../ledger/ledger.types';
import {
  clearingToPayableEntries,
  clearingToUserEntries,
  partialChargebackEntries,
  settleDepositFromClearingEntries,
  writeOffEntries,
} from './correction-posting';

const USER = '00000000-0000-4000-8000-000000000001';

/** Σ debits − Σ credits in one currency (the ledger's own rule, recomputed independently). */
function net(entries: readonly LedgerEntryDraft[]): bigint {
  return entries.reduce((sum, entry) => sum + (entry.direction === EntryDirection.DEBIT ? entry.amount.amountMinor : -entry.amount.amountMinor), 0n);
}

const shape = (entries: readonly LedgerEntryDraft[]) =>
  entries.map((entry) => [
    'systemAccount' in entry.account ? entry.account.systemAccount : 'USER',
    entry.direction,
    entry.amount.amountMinor,
    entry.amount.currency,
  ]);

describe('correction and write-off postings (Phase 10 plan §F, worked)', () => {
  it('CLEARING → user: DR CLEARING / CR the user', () => {
    expect(shape(clearingToUserEntries(Money.of(2_500_000n, 'NGN'), USER))).toEqual([
      ['CLEARING', 'DEBIT', 2_500_000n, 'NGN'],
      ['USER', 'CREDIT', 2_500_000n, 'NGN'],
    ]);
  });

  it('amount mismatch, the PSP settled less (₦9,500 for ₦10,000): the user bears ₦500', () => {
    expect(shape(settleDepositFromClearingEntries(Money.of(950_000n, 'NGN'), Money.of(1_000_000n, 'NGN'), USER))).toEqual([
      ['CLEARING', 'DEBIT', 950_000n, 'NGN'],
      ['PSP_RECEIVABLE', 'CREDIT', 1_000_000n, 'NGN'],
      ['USER', 'DEBIT', 50_000n, 'NGN'],
    ]);
  });

  it('amount mismatch, the PSP settled more: the user is credited the difference; equal amounts need no user leg', () => {
    expect(shape(settleDepositFromClearingEntries(Money.of(1_000_100n, 'NGN'), Money.of(1_000_000n, 'NGN'), USER)).at(-1)).toEqual(['USER', 'CREDIT', 100n, 'NGN']);
    expect(settleDepositFromClearingEntries(Money.of(10n, 'NGN'), Money.of(10n, 'NGN'), USER)).toHaveLength(2);
  });

  it('duplicate line → PSP_PAYABLE; partial chargeback → CLEARING or the receivable; write-off → EXPENSE:WRITE_OFF', () => {
    expect(shape(clearingToPayableEntries(Money.of(7n, 'KWD')))).toEqual([
      ['CLEARING', 'DEBIT', 7n, 'KWD'],
      ['PSP_PAYABLE', 'CREDIT', 7n, 'KWD'],
    ]);
    expect(shape(partialChargebackEntries(Money.of(300_000n, 'NGN'), USER, 'PSP_RECEIVABLE'))).toEqual([
      ['USER', 'DEBIT', 300_000n, 'NGN'],
      ['PSP_RECEIVABLE', 'CREDIT', 300_000n, 'NGN'],
    ]);
    expect(shape(partialChargebackEntries(Money.of(1n, 'JPY'), USER, 'CLEARING'))[1]).toEqual(['CLEARING', 'CREDIT', 1n, 'JPY']);
    expect(shape(writeOffEntries(Money.of(200_000n, 'NGN'), USER))).toEqual([
      ['EXPENSE:WRITE_OFF', 'DEBIT', 200_000n, 'NGN'],
      ['USER', 'CREDIT', 200_000n, 'NGN'],
    ]);
  });

  it('refuses a zero amount and a two-currency correction (fail loudly)', () => {
    expect(() => clearingToUserEntries(Money.of(0n, 'NGN'), USER)).toThrow(/positive/);
    expect(() => writeOffEntries(Money.of(0n, 'NGN'), USER)).toThrow(/positive/);
    expect(() => settleDepositFromClearingEntries(Money.of(10n, 'USD'), Money.of(10n, 'NGN'), USER)).toThrow(/one currency/);
  });

  it('property: every builder balances in one currency, for any positive amounts and JPY (0) / NGN (2) / KWD (3)', () => {
    const amount = fc.bigInt({ min: 1n, max: 10n ** 15n });
    const currency = fc.constantFrom('JPY', 'NGN', 'KWD');
    fc.assert(
      fc.property(amount, amount, currency, (line, booked, code) => {
        const postings = [
          clearingToUserEntries(Money.of(line, code), USER),
          clearingToPayableEntries(Money.of(line, code)),
          settleDepositFromClearingEntries(Money.of(line, code), Money.of(booked, code), USER),
          partialChargebackEntries(Money.of(line, code), USER, 'CLEARING'),
          writeOffEntries(Money.of(line, code), USER),
        ];
        for (const entries of postings) {
          expect(net(entries)).toBe(0n);
          expect(entries.every((entry) => entry.amount.amountMinor > 0n && entry.amount.currency === code)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
