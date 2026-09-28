import { InvalidAmountError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { InvalidPostingError, LedgerUnbalancedError } from '../ledger.errors';
import {
  AccountReference,
  EntryDirection,
  PostingAuthorization,
  PostingRequest,
  TransactionType,
} from '../ledger.types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INITIATED_BY_PATTERN = /^(user|operator|job):.+$/;
const SYSTEM_ACCOUNT_PATTERN = /^[A-Z_]+(:[A-Z_]+)*$/;
const TYPES_THAT_CORRECT = new Set<TransactionType>([TransactionType.REVERSAL, TransactionType.CORRECTION]);

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isOneOf<T extends string>(values: Record<string, T>, value: unknown): value is T {
  return Object.values(values).includes(value as T);
}

function describeReference(reference: AccountReference): string {
  return 'accountId' in reference ? reference.accountId : reference.systemAccount;
}

function validateAccountReference(reference: AccountReference | undefined, index: number): void {
  if (typeof reference !== 'object' || reference === null) {
    throw new InvalidPostingError(`Entry ${index} has no account.`, { entryIndex: index });
  }
  const hasAccountId = 'accountId' in reference;
  const hasSystemAccount = 'systemAccount' in reference;
  if (hasAccountId === hasSystemAccount) {
    throw new InvalidPostingError(`Entry ${index} must name exactly one of accountId or systemAccount.`, {
      entryIndex: index,
    });
  }
  if (hasAccountId && !isUuid(reference.accountId)) {
    throw new InvalidPostingError(`Entry ${index} has a malformed accountId.`, { entryIndex: index });
  }
  if (
    hasSystemAccount &&
    (typeof reference.systemAccount !== 'string' ||
      !SYSTEM_ACCOUNT_PATTERN.test(reference.systemAccount) ||
      reference.systemAccount.startsWith('USER'))
  ) {
    throw new InvalidPostingError(`Entry ${index} has a malformed systemAccount.`, {
      entryIndex: index,
      systemAccount: String(reference.systemAccount),
    });
  }
}

/**
 * Everything about a posting that can be checked without the database (design §6.1,
 * "at runtime"). Runs BEFORE any write, so a rejected posting leaves no trace.
 *
 * The balance rule is per currency, never global: an NGN debit of 100 and a USD
 * credit of 100 is unbalanced, because they are different units (design §5.6).
 */
export function validatePostingRequest(request: PostingRequest): void {
  const { transaction, entries } = request;

  if (!isOneOf(TransactionType, transaction.type)) {
    throw new InvalidPostingError('Unknown transaction type.', { type: String(transaction.type) });
  }
  if (!isOneOf(PostingAuthorization, transaction.authorization)) {
    throw new InvalidPostingError('Unknown posting authorization.', {
      authorization: String(transaction.authorization),
    });
  }
  if (!isValidDate(transaction.valueTime)) {
    throw new InvalidPostingError('valueTime must be a valid Date.');
  }
  if (transaction.settlementTime !== undefined && !isValidDate(transaction.settlementTime)) {
    throw new InvalidPostingError('settlementTime must be a valid Date when given.');
  }
  if (typeof transaction.initiatedBy !== 'string' || !INITIATED_BY_PATTERN.test(transaction.initiatedBy)) {
    throw new InvalidPostingError("initiatedBy must be 'user:{id}', 'operator:{id}' or 'job:{name}'.", {
      initiatedBy: String(transaction.initiatedBy),
    });
  }
  if (transaction.userId !== undefined && !isUuid(transaction.userId)) {
    throw new InvalidPostingError('userId must be a UUID when given.');
  }
  if (transaction.reference !== undefined && (typeof transaction.reference !== 'string' || transaction.reference.trim() === '')) {
    throw new InvalidPostingError('reference must be a non-empty string when given.');
  }

  const correctsSomething = transaction.correctsTransactionId !== undefined;
  if (correctsSomething && !isUuid(transaction.correctsTransactionId)) {
    throw new InvalidPostingError('correctsTransactionId must be a UUID.');
  }
  if (TYPES_THAT_CORRECT.has(transaction.type) !== correctsSomething) {
    throw new InvalidPostingError(
      'REVERSAL and CORRECTION postings must link the transaction they correct; other types must not.',
      { type: transaction.type },
    );
  }

  if (!Array.isArray(entries) || entries.length < 2) {
    throw new InvalidPostingError('A posting needs at least two entries.', {
      entryCount: Array.isArray(entries) ? entries.length : 0,
    });
  }

  const totals = new Map<string, { debitMinor: bigint; creditMinor: bigint }>();
  entries.forEach((entry, index) => {
    validateAccountReference(entry.account, index);
    if (!isOneOf(EntryDirection, entry.direction)) {
      throw new InvalidPostingError(`Entry ${index} has an unknown direction.`, { entryIndex: index });
    }
    if (!(entry.amount instanceof Money)) {
      throw new InvalidPostingError(`Entry ${index} amount must be Money.`, { entryIndex: index });
    }
    if (!entry.amount.isPositive()) {
      throw new InvalidAmountError(`Entry ${index} amount must be greater than zero.`, {
        entryIndex: index,
        account: describeReference(entry.account),
        amountMinor: entry.amount.toMinorString(),
        currency: entry.amount.currency,
      });
    }
    const total = totals.get(entry.amount.currency) ?? { debitMinor: 0n, creditMinor: 0n };
    if (entry.direction === EntryDirection.DEBIT) total.debitMinor += entry.amount.amountMinor;
    else total.creditMinor += entry.amount.amountMinor;
    totals.set(entry.amount.currency, total);
  });

  const unbalanced = [...totals.entries()]
    .filter(([, total]) => total.debitMinor !== total.creditMinor)
    .map(([currency, total]) => ({
      currency,
      debitMinor: total.debitMinor.toString(),
      creditMinor: total.creditMinor.toString(),
    }));
  if (unbalanced.length > 0) {
    throw new LedgerUnbalancedError('Debits must equal credits in every currency.', { unbalanced });
  }
}
