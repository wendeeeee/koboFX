import { InvariantViolationError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { EntryDirection, LedgerEntryDraft } from '../../ledger/ledger.types';

/**
 * The postings of the controls (Phase 10 plan §F), pure. Every amount is already in minor units (a settlement
 * line, a booked deposit, a dispute, a balance): nothing is priced and nothing is rounded, so JPY (0) and KWD (3)
 * need nothing special. Each builder returns entries that balance in ONE currency; `post()` checks it again.
 */

function assertPositive(amount: Money, what: string): void {
  if (amount.amountMinor <= 0n) throw new InvariantViolationError(`${what} must be positive.`, { amountMinor: amount.toMinorString() });
}

function assertSameCurrency(...amounts: Money[]): void {
  const [first] = amounts;
  for (const amount of amounts) {
    if (amount.currency !== first?.currency) {
      throw new InvariantViolationError('A correction is posted in one currency.', { currencies: amounts.map((each) => each.currency) });
    }
  }
}

/** A settlement line in CLEARING that an operator attributed to a user: DR CLEARING / CR the user. */
export function clearingToUserEntries(lineAmount: Money, userAccountId: string): LedgerEntryDraft[] {
  assertPositive(lineAmount, 'The line amount');
  return [
    { account: { systemAccount: 'CLEARING' }, direction: EntryDirection.DEBIT, amount: lineAmount },
    { account: { accountId: userAccountId }, direction: EntryDirection.CREDIT, amount: lineAmount },
  ];
}

/** A settlement line in CLEARING we owe back to the PSP (a duplicate): DR CLEARING / CR PSP_PAYABLE. */
export function clearingToPayableEntries(lineAmount: Money): LedgerEntryDraft[] {
  assertPositive(lineAmount, 'The line amount');
  return [
    { account: { systemAccount: 'CLEARING' }, direction: EntryDirection.DEBIT, amount: lineAmount },
    { account: { systemAccount: 'PSP_PAYABLE' }, direction: EntryDirection.CREDIT, amount: lineAmount },
  ];
}

/**
 * A line in CLEARING that is one of our deposits (the PSP settled `line` for a deposit we booked as `booked`):
 * the line leaves CLEARING, the deposit's receivable is discharged in full, and the difference — the PSP's truth
 * wins — goes to the user: a CREDIT when the PSP captured more, a DEBIT (may overdraw; recorded) when less.
 */
export function settleDepositFromClearingEntries(line: Money, booked: Money, userAccountId: string): LedgerEntryDraft[] {
  assertPositive(line, 'The line amount');
  assertPositive(booked, 'The booked amount');
  assertSameCurrency(line, booked);
  const entries: LedgerEntryDraft[] = [
    { account: { systemAccount: 'CLEARING' }, direction: EntryDirection.DEBIT, amount: line },
    { account: { systemAccount: 'PSP_RECEIVABLE' }, direction: EntryDirection.CREDIT, amount: booked },
  ];
  const difference = line.amountMinor - booked.amountMinor;
  if (difference > 0n) {
    entries.push({ account: { accountId: userAccountId }, direction: EntryDirection.CREDIT, amount: Money.of(difference, line.currency) });
  } else if (difference < 0n) {
    entries.push({ account: { accountId: userAccountId }, direction: EntryDirection.DEBIT, amount: Money.of(-difference, line.currency) });
  }
  return entries;
}

/**
 * A partial chargeback: the user gives back the disputed amount. If the PSP has already deducted it (a
 * deduction line sat in CLEARING), the credit discharges CLEARING; otherwise it discharges the receivable, which
 * the deduction will settle when it comes. May overdraw the user: recorded faithfully, never clamped.
 */
export function partialChargebackEntries(disputed: Money, userAccountId: string, deductedInto: 'CLEARING' | 'PSP_RECEIVABLE'): LedgerEntryDraft[] {
  assertPositive(disputed, 'The disputed amount');
  return [
    { account: { accountId: userAccountId }, direction: EntryDirection.DEBIT, amount: disputed },
    { account: { systemAccount: deductedInto }, direction: EntryDirection.CREDIT, amount: disputed },
  ];
}

/** An unrecoverable overdraft (design §6.4): DR EXPENSE:WRITE_OFF / CR the user, bringing the balance towards 0. */
export function writeOffEntries(amount: Money, userAccountId: string): LedgerEntryDraft[] {
  assertPositive(amount, 'The write-off');
  return [
    { account: { systemAccount: 'EXPENSE:WRITE_OFF' }, direction: EntryDirection.DEBIT, amount },
    { account: { accountId: userAccountId }, direction: EntryDirection.CREDIT, amount },
  ];
}
