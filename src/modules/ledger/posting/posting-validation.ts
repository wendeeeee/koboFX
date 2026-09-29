import { InvalidAmountError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { InvalidPostingError, LedgerUnbalancedError } from '../ledger.errors';
import {
  AccountReference,
  ConversionProvenance,
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

const PLAIN_POSITIVE_DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

function validateConversion(conversion: ConversionProvenance, request: PostingRequest): void {
  const fail = (message: string): never => {
    throw new InvalidPostingError(`Conversion provenance: ${message}`);
  };
  if (!CURRENCY_CODE.test(conversion.sourceCurrency) || !CURRENCY_CODE.test(conversion.targetCurrency)) fail('currencies must be ISO codes.');
  if (conversion.sourceCurrency === conversion.targetCurrency) fail('source and target currency must differ.');
  if (typeof conversion.sourceAmountMinor !== 'bigint' || conversion.sourceAmountMinor <= 0n) fail('the source amount must be positive.');
  if (typeof conversion.targetAmountMinor !== 'bigint' || conversion.targetAmountMinor <= 0n) fail('the target amount must be positive.');
  for (const [name, rate] of [['rateDisplay', conversion.rateDisplay], ['referenceRate', conversion.referenceRate]] as const) {
    if (typeof rate !== 'string' || !PLAIN_POSITIVE_DECIMAL.test(rate) || /^0(\.0+)?$/.test(rate)) fail(`${name} must be a positive plain decimal.`);
  }
  if (typeof conversion.rateProvider !== 'string' || conversion.rateProvider === '') fail('the provider is required.');
  if (!isValidDate(conversion.rateFetchedAt) || !isValidDate(conversion.rateProviderUpdatedAt)) fail('rate times must be valid Dates.');
  if (!isUuid(conversion.rateSnapshotId)) fail('the snapshot id must be a UUID.');
  if (conversion.quoteId !== undefined && !isUuid(conversion.quoteId)) fail('the quote id must be a UUID when given.');
  if (!Number.isInteger(conversion.spreadBasisPoints) || conversion.spreadBasisPoints < 0 || conversion.spreadBasisPoints >= 10_000) {
    fail('the spread must be an integer number of basis points in [0, 10000).');
  }
  const currencies = new Set(request.entries.map((entry) => entry.amount.currency));
  if (currencies.size !== 2 || !currencies.has(conversion.sourceCurrency) || !currencies.has(conversion.targetCurrency)) {
    fail('the entries must be in exactly the source and target currencies.');
  }
  const sourceDebits = request.entries
    .filter((entry) => entry.amount.currency === conversion.sourceCurrency && entry.direction === EntryDirection.DEBIT)
    .reduce((sum, entry) => sum + entry.amount.amountMinor, 0n);
  if (sourceDebits !== conversion.sourceAmountMinor) fail('the source amount must equal the source-currency debits.');
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

  if ((transaction.type === TransactionType.CONVERSION) !== (transaction.conversion !== undefined)) {
    throw new InvalidPostingError('CONVERSION postings must carry their conversion provenance; other types must not.', {
      type: transaction.type,
    });
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
  if (transaction.conversion !== undefined) validateConversion(transaction.conversion, request);
}
