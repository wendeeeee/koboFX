import { InvariantViolationError } from '../../common/errors';
import { dec } from '../../common/money';
import { displayRate } from '../fx/pricing';
import { HistoryInitiator, HistoryStatus, initiatorOf, statusOfTransaction, statusOfUnpostedFunding, statusOfUnpostedWithdrawal } from './history-status';


export interface LegView {
  readonly currency: string;
  readonly minorUnit: number;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly amount: string;
}


export interface DetailLegView extends LegView {
  readonly balanceAfter: string;
}

export interface AmountView {
  readonly currency: string;
  readonly minorUnit: number;
  readonly amount: string;
}

export type LinkView = { readonly reference: string; readonly type: string } | { readonly internal: true };

export interface ListRateView {

  readonly rateDisplay: string;
  readonly quoteId: string | null;
}

export interface DetailRateView extends ListRateView {
  readonly referenceRate: string;
  readonly spreadBasisPoints: number;
  readonly provider: string;
  readonly asOf: string;
  readonly fetchedAt: string;
  readonly snapshotId: string;
}

export interface TransactionListItemView {
  readonly reference: string;
  readonly type: string;
  readonly status: HistoryStatus;
  readonly reasonCode: string | null;
  readonly legs: readonly LegView[];
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

export type HistorySource = 'TRANSACTION' | 'FUNDING' | 'WITHDRAWAL';

export interface LegRow {
  readonly currency: string;
  readonly minorUnit: number;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly amount: string;
  readonly balanceAfter: string;
}

export interface HistoryRow {
  readonly source: HistorySource;
  readonly id: string;
  readonly position_microseconds: string;
  readonly reference: string;
  readonly type: string;
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
  readonly corrects_internal?: boolean;
  readonly metadata?: Record<string, unknown> | null;
  readonly external_reference?: string | null;
  readonly correction_subject?: string | null;
  readonly all_legs?: readonly AdminLegRow[] | null;
}

export interface AdminLegRow extends LegRow {
  readonly accountCode: string;
  readonly bucket: number;
  readonly owner: 'USER' | 'INTERNAL' | 'OTHER_USER';
}

export interface AdminLegView extends DetailLegView {
  readonly accountCode: string;
  readonly bucket: number;
  readonly owner: 'USER' | 'INTERNAL';
}


export interface AdminTransactionView extends Omit<TransactionDetailView, 'legs'> {
  readonly legs: readonly AdminLegView[];
  readonly initiatedByIdentity: string;
  readonly metadata: Record<string, unknown>;
  readonly externalReference: string | null;
  readonly correctionSubject: string | null;
  readonly approvalId: string | null;
}

export function adminTransactionView(row: HistoryRow): AdminTransactionView {
  const detail = detailView(row);
  const legs = (row.all_legs ?? []).map((leg): AdminLegView => {
    if (leg.owner === 'OTHER_USER') {
      throw new InvariantViolationError("A transaction in this user's history has a leg on another user's account.", { reference: row.reference });
    }
    return {
      accountCode: leg.accountCode,
      bucket: leg.bucket,
      owner: leg.owner,
      currency: leg.currency,
      minorUnit: leg.minorUnit,
      direction: leg.direction,
      amount: leg.amount,
      balanceAfter: leg.balanceAfter,
    };
  });
  const metadata = row.metadata ?? {};
  return {
    ...detail,
    legs,
    initiatedByIdentity: row.initiated_by,
    metadata,
    externalReference: row.external_reference ?? null,
    correctionSubject: row.correction_subject ?? null,
    approvalId: typeof metadata.approvalId === 'string' ? metadata.approvalId : null,
  };
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
    status: statusOf(row),
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
    corrects: linkOf(row.corrects_transaction_id, row.corrects_reference, row.corrects_type, row.corrects_internal === true),
    correctedBy: linkOf(row.corrected_by_transaction_id, row.corrected_by_reference, row.corrected_by_type, false),
    settlementTime: row.settlement_time?.toISOString() ?? null,
    initiatedBy: initiatorOf(row.initiated_by),
  };
}

function statusOf(row: HistoryRow): HistoryStatus {
  switch (row.source) {
    case 'TRANSACTION':
      return statusOfTransaction(row.status);
    case 'FUNDING':
      return statusOfUnpostedFunding(row.status);
    case 'WITHDRAWAL':
      return statusOfUnpostedWithdrawal(row.status);
    default:
      throw new InvariantViolationError('Unknown history source.', { source: row.source as string });
  }
}

function requestedOf(row: HistoryRow): AmountView {
  if (row.requested_currency === null || row.requested_minor_unit === null || row.requested_amount === null) {
    throw new InvariantViolationError('An unposted item has no requested amount.', { reference: row.reference });
  }
  return { currency: row.requested_currency, minorUnit: row.requested_minor_unit, amount: row.requested_amount };
}


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

function linkOf(transactionId: string | null, reference: string | null, type: string | null, internal: boolean): LinkView | null {
  if (transactionId === null) return null;
  if ((reference === null || type === null) && internal) return { internal: true };
  if (reference === null || type === null) {
    throw new InvariantViolationError('A linked transaction is not visible to the same user.', { transactionId });
  }
  return { reference, type };
}
