import { InvariantViolationError } from '../../common/errors';
import { dec } from '../../common/money';
import { displayRate } from '../fx/pricing';
import { HistoryInitiator, HistoryStatus, initiatorOf, statusOfTransaction, statusOfUnpostedFunding } from './history-status';

/**
 * History on the wire (design §7.8, Phase 8 decisions). "No invented data": every figure is a
 * stored one — amounts are the ledger entries' minor units as strings, rates the stored display
 * and reference rates formatted by `displayRate()` (never recomputed from a current rate).
 *
 * Hidden, always: internal legs (FX_POSITION, REVENUE, PSP_RECEIVABLE, EXPENSE — the position's
 * target leg is the mid value, and mid value − credit is our revenue), `metadata`,
 * `external_reference`, the initiator's identity.
 */

/** One of the USER's own legs. `direction` is the ledger's, which on a user (liability) account reads like a bank statement: DEBIT = out. */
export interface LegView {
  readonly currency: string;
  readonly minorUnit: number;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly amount: string;
}

/** On the detail only: the account's balance after this booking (in booking order, not value order). */
export interface DetailLegView extends LegView {
  readonly balanceAfter: string;
}

export interface AmountView {
  readonly currency: string;
  readonly minorUnit: number;
  readonly amount: string;
}

export interface LinkView {
  readonly reference: string;
  readonly type: string;
}

export interface ListRateView {
  /** The effective client rate, derived from the two amounts at posting (display only; the amounts are authoritative). */
  readonly rateDisplay: string;
  /** The quote a trade executed; null for a market conversion. */
  readonly quoteId: string | null;
}

export interface DetailRateView extends ListRateView {
  /** The reference mid priced off (target per source), as a display string. */
  readonly referenceRate: string;
  readonly spreadBasisPoints: number;
  readonly provider: string;
  /** The provider's publication time of the rate. */
  readonly asOf: string;
  readonly fetchedAt: string;
  readonly snapshotId: string;
}

export interface TransactionListItemView {
  readonly reference: string;
  readonly type: string;
  readonly status: HistoryStatus;
  readonly reasonCode: string | null;
  /** The user's own legs; empty for a funding that never posted (nothing moved). */
  readonly legs: readonly LegView[];
  /** What a funding that never posted asked for; null once money moved (see `legs`). */
  readonly requested: AmountView | null;
  readonly rate: ListRateView | null;
  readonly failureCode: string | null;
  readonly valueTime: string;
  readonly bookingTime: string;
  readonly corrects: LinkView | null;
  readonly correctedBy: LinkView | null;
}

export interface TransactionDetailView extends Omit<TransactionListItemView, 'legs' | 'rate'> {
  readonly legs: readonly DetailLegView[];
  readonly rate: DetailRateView | null;
  readonly settlementTime: string | null;
  readonly initiatedBy: HistoryInitiator;
}

export type HistorySource = 'TRANSACTION' | 'FUNDING';

/** A leg as the repository's JSON aggregate returns it. */
export interface LegRow {
  readonly currency: string;
  readonly minorUnit: number;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly amount: string;
  readonly balanceAfter: string;
}

/** One history row, as `TransactionHistoryRepository` selects it (snake_case, raw from `pg`). */
export interface HistoryRow {
  readonly source: HistorySource;
  readonly id: string;
  readonly position_microseconds: string;
  readonly reference: string;
  readonly type: string;
  /** `transactions.status`, or the funding flow's state for an unposted funding. */
  readonly status: string;
  readonly reason_code: string | null;
  readonly initiated_by: string;
  readonly failure_code: string | null;
  readonly value_time: Date;
  readonly booking_time: Date;
  readonly settlement_time: Date | null;
  readonly rate_display: string | null;
  readonly reference_rate: string | null;
  readonly rate_provider: string | null;
  readonly rate_fetched_at: Date | null;
  readonly rate_provider_updated_at: Date | null;
  readonly rate_snapshot_id: string | null;
  readonly spread_basis_points: number | null;
  readonly quote_id: string | null;
  /** The raw link ids: a link whose row the caller-scoped join did not return is a broken assumption. */
  readonly corrects_transaction_id: string | null;
  readonly corrected_by_transaction_id: string | null;
  readonly corrects_reference: string | null;
  readonly corrects_type: string | null;
  readonly corrected_by_reference: string | null;
  readonly corrected_by_type: string | null;
  readonly legs: readonly LegRow[] | null;
  readonly requested_currency: string | null;
  readonly requested_minor_unit: number | null;
  readonly requested_amount: string | null;
}

export function listItemView(row: HistoryRow): TransactionListItemView {
  const detail = detailView(row);
  return {
    reference: detail.reference,
    type: detail.type,
    status: detail.status,
    reasonCode: detail.reasonCode,
    legs: detail.legs.map(({ currency, minorUnit, direction, amount }) => ({ currency, minorUnit, direction, amount })),
    requested: detail.requested,
    rate: detail.rate ? { rateDisplay: detail.rate.rateDisplay, quoteId: detail.rate.quoteId } : null,
    failureCode: detail.failureCode,
    valueTime: detail.valueTime,
    bookingTime: detail.bookingTime,
    corrects: detail.corrects,
    correctedBy: detail.correctedBy,
  };
}

export function detailView(row: HistoryRow): TransactionDetailView {
  const posted = row.source === 'TRANSACTION';
  return {
    reference: row.reference,
    type: row.type,
    status: posted ? statusOfTransaction(row.status) : statusOfUnpostedFunding(row.status),
    reasonCode: row.reason_code,
    legs: (row.legs ?? []).map((leg) => ({
      currency: leg.currency,
      minorUnit: leg.minorUnit,
      direction: leg.direction,
      amount: leg.amount,
      balanceAfter: leg.balanceAfter,
    })),
    requested: posted ? null : requestedOf(row),
    rate: rateOf(row),
    failureCode: row.failure_code,
    valueTime: row.value_time.toISOString(),
    bookingTime: row.booking_time.toISOString(),
    corrects: linkOf(row.corrects_transaction_id, row.corrects_reference, row.corrects_type),
    correctedBy: linkOf(row.corrected_by_transaction_id, row.corrected_by_reference, row.corrected_by_type),
    settlementTime: row.settlement_time?.toISOString() ?? null,
    initiatedBy: initiatorOf(row.initiated_by),
  };
}

function requestedOf(row: HistoryRow): AmountView {
  if (row.requested_currency === null || row.requested_minor_unit === null || row.requested_amount === null) {
    throw new InvariantViolationError('An unposted funding has no requested amount.', { reference: row.reference });
  }
  return { currency: row.requested_currency, minorUnit: row.requested_minor_unit, amount: row.requested_amount };
}

/** A conversion's rate, from its stored provenance (the CHECK guarantees every field is present). */
function rateOf(row: HistoryRow): DetailRateView | null {
  if (row.rate_display === null) return null;
  if (
    row.reference_rate === null || row.rate_provider === null || row.rate_fetched_at === null ||
    row.rate_provider_updated_at === null || row.rate_snapshot_id === null || row.spread_basis_points === null
  ) {
    throw new InvariantViolationError('A transaction with a rate has incomplete provenance.', { reference: row.reference });
  }
  return {
    rateDisplay: displayRate(dec(row.rate_display)),
    quoteId: row.quote_id,
    referenceRate: displayRate(dec(row.reference_rate)),
    spreadBasisPoints: row.spread_basis_points,
    provider: row.rate_provider,
    asOf: row.rate_provider_updated_at.toISOString(),
    fetchedAt: row.rate_fetched_at.toISOString(),
    snapshotId: row.rate_snapshot_id,
  };
}

/** Both ends of a correction belong to the same user (a reversal copies the original's `user_id`); fail loudly if not. */
function linkOf(transactionId: string | null, reference: string | null, type: string | null): LinkView | null {
  if (transactionId === null) return null;
  if (reference === null || type === null) {
    throw new InvariantViolationError('A linked transaction is not visible to the same user.', { transactionId });
  }
  return { reference, type };
}
