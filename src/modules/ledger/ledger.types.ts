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
}

export enum TransactionStatus {
  PENDING = 'PENDING',
  POSTED = 'POSTED',
  FAILED = 'FAILED',
  REVERSED = 'REVERSED',
}

/**
 * Who asked for the money to move (design §6.2).
 *
 * - `USER_INITIATED`: every debit that reduces a balance-authorizing account must
 *   fit within `available = balance − reserved` plus the overdraft limit.
 * - `SYSTEM_DRIVEN`: a reversal, write-off or settlement correction records what
 *   already happened in the world. It may push an account negative, and the ledger
 *   records that faithfully — it never clamps and never refuses.
 */
export enum PostingAuthorization {
  USER_INITIATED = 'USER_INITIATED',
  SYSTEM_DRIVEN = 'SYSTEM_DRIVEN',
}

/**
 * Which account an entry hits.
 *
 * - `{ accountId }` — a specific account row (user accounts, or a specific bucket).
 * - `{ systemAccount }` — an internal account by template name, e.g. `'FX_POSITION'`.
 *   The currency is the entry amount's currency, and the bucket is chosen from the
 *   transaction id (design §6.6), so callers never pick hot rows themselves.
 */
export type AccountReference = { readonly accountId: string } | { readonly systemAccount: string };

export interface LedgerEntryDraft {
  readonly account: AccountReference;
  readonly direction: EntryDirection;
  /** Strictly positive; its currency must equal the account's currency. */
  readonly amount: Money;
}

export interface TransactionDraft {
  readonly type: TransactionType;
  readonly authorization: PostingAuthorization;
  /** When the transaction economically occurred. Booking time is always the database's `now()`. */
  readonly valueTime: Date;
  /** `user:{id}` | `operator:{id}` | `job:{name}` — the audit trail's *who*. */
  readonly initiatedBy: string;
  /** Unique, human-quotable. Defaults to the transaction id. */
  readonly reference?: string;
  readonly userId?: string;
  /** The audit trail's *why*. */
  readonly reasonCode?: string;
  /** The provider's own id: turns reconciliation into a join. */
  readonly externalReference?: string;
  /** Required for REVERSAL and CORRECTION, forbidden otherwise. Links both directions. */
  readonly correctsTransactionId?: string;
  readonly idempotencyKey?: string;
  readonly settlementTime?: Date;
  readonly metadata?: Record<string, unknown>;
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
