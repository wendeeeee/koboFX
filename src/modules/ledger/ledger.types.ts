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
  /** A PSP settlement batch (Phase 9): no user, never in any user's history. */
  SETTLEMENT = 'SETTLEMENT',
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

/**
 * What a CONVERSION records beyond its entries (design §4.3, §5.4): both legs' amounts and
 * the provenance of the reference rate it was priced off. Required for CONVERSION, refused
 * otherwise; the database CHECK `transactions_conversion_provenance` says the same.
 */
export interface ConversionProvenance {
  readonly sourceCurrency: string;
  readonly sourceAmountMinor: bigint;
  readonly targetCurrency: string;
  readonly targetAmountMinor: bigint;
  /** Display only, derived from the two amounts (the amounts are authoritative). A plain decimal string. */
  readonly rateDisplay: string;
  /** The reference mid priced off (target per source), exact, as a plain decimal string. */
  readonly referenceRate: string;
  readonly rateProvider: string;
  readonly rateFetchedAt: Date;
  /** The provider's publication time of the snapshot. */
  readonly rateProviderUpdatedAt: Date;
  /** The ACCEPTED exchange rate snapshot priced off. */
  readonly rateSnapshotId: string;
  readonly spreadBasisPoints: number;
  /** The quote a trade executed; absent for a market conversion. */
  readonly quoteId?: string;
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
  /**
   * Which part of an INTERNAL original (`user_id` NULL, e.g. a SETTLEMENT) a CORRECTION corrects, e.g.
   * `line:{settlementBatchLineId}` (Phase 10 plan §A.1). Only for a CORRECTION of an internal original (refused
   * otherwise); without one, the original is corrected at most once, as always. Each subject is corrected at most
   * once; the original's `corrected_by` link stays unset (the reverse link lives on the corrected subject).
   */
  readonly correctionSubject?: string;
  readonly idempotencyKey?: string;
  readonly settlementTime?: Date;
  readonly metadata?: Record<string, unknown>;
  /** Required for CONVERSION, forbidden otherwise. */
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
