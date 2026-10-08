import { Money } from '../../common/money';

export enum AccountType {
  ASSET = 'ASSET',
  LIABILITY = 'LIABILITY',
  EQUITY = 'EQUITY',
  REVENUE = 'REVENUE',
  EXPENSE = 'EXPENSE',
}

export enum NormalSide {
  DEBIT = 'DEBIT',
  CREDIT = 'CREDIT',
}

export enum EntryDirection {
  DEBIT = 'DEBIT',
  CREDIT = 'CREDIT',
}

export enum TransactionType {
  FUNDING = 'FUNDING',
  CONVERSION = 'CONVERSION',
  WITHDRAWAL = 'WITHDRAWAL',
  REVERSAL = 'REVERSAL',
  CORRECTION = 'CORRECTION',
  PROMOTIONAL = 'PROMOTIONAL',
  WRITE_OFF = 'WRITE_OFF',
  SETTLEMENT = 'SETTLEMENT',
}

export enum TransactionStatus {
  PENDING = 'PENDING',
  POSTED = 'POSTED',
  FAILED = 'FAILED',
  REVERSED = 'REVERSED',
}


export enum PostingAuthorization {
  USER_INITIATED = 'USER_INITIATED',
  SYSTEM_DRIVEN = 'SYSTEM_DRIVEN',
}

/**
 * Which account an entry hits.
 *
 * - `{ accountId }` — a specific account row (user accounts, or a specific bucket).
 * - `{ systemAccount }` — an internal account by template name, e.g. `'FX_POSITION'`.
 */
export type AccountReference = { readonly accountId: string } | { readonly systemAccount: string };

export interface LedgerEntryDraft {
  readonly account: AccountReference;
  readonly direction: EntryDirection;
  readonly amount: Money;
}

export interface ConversionProvenance {
  readonly sourceCurrency: string;
  readonly sourceAmountMinor: bigint;
  readonly targetCurrency: string;
  readonly targetAmountMinor: bigint;
  readonly rateDisplay: string;
  readonly referenceRate: string;
  readonly rateProvider: string;
  readonly rateFetchedAt: Date;
  readonly rateProviderUpdatedAt: Date;
  readonly rateSnapshotId: string;
  readonly spreadBasisPoints: number;
  readonly quoteId?: string;
}

export interface TransactionDraft {
  readonly type: TransactionType;
  readonly authorization: PostingAuthorization;
  readonly valueTime: Date;
  readonly initiatedBy: string;
  readonly reference?: string;
  readonly userId?: string;
  readonly reasonCode?: string;
  readonly externalReference?: string;
  readonly correctsTransactionId?: string;
  readonly correctionSubject?: string;
  readonly idempotencyKey?: string;
  readonly settlementTime?: Date;
  readonly metadata?: Record<string, unknown>;
  readonly conversion?: ConversionProvenance;
}

export interface PostingRequest {
  readonly transaction: TransactionDraft;
  readonly entries: readonly LedgerEntryDraft[];
}

export interface PostedEntry {
  readonly entryId: bigint;
  readonly accountId: string;
  readonly direction: EntryDirection;
  readonly amount: Money;
  readonly balanceAfterMinor: bigint;
}

export interface PostedTransaction {
  readonly transactionId: string;
  readonly reference: string;
  readonly type: TransactionType;
  readonly status: TransactionStatus;
  readonly valueTime: Date;
  readonly bookingTime: Date;
  readonly entries: readonly PostedEntry[];
}
