import { InvariantViolationError } from '../../common/errors';
import { FundingState, fundingStatusOf, isFundingState } from '../flows/funding/funding-transitions';
import { TransactionStatus, TransactionType } from '../ledger/ledger.types';

/**
 * ONE status vocabulary on the wire for every history item (Phase 8 decision 8), the same as
 * `GET /wallet/fund/:fundingId`'s: a client never learns two.
 */
export type HistoryStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERSED';

/**
 * A booked transaction's status. POSTED → `COMPLETED`; an original a REVERSAL negated →
 * `REVERSED` (the reversal itself is `COMPLETED`); a CORRECTED original stays POSTED →
 * `COMPLETED`, with its `correctedBy` link.
 */
export function statusOfTransaction(status: string): HistoryStatus {
  switch (status) {
    case TransactionStatus.POSTED:
      return 'COMPLETED';
    case TransactionStatus.REVERSED:
      return 'REVERSED';
    case TransactionStatus.PENDING:
      return 'PENDING';
    case TransactionStatus.FAILED:
      return 'FAILED';
    default:
      throw new InvariantViolationError(`Unknown transaction status ${status}.`);
  }
}

/** A funding that never posted: PENDING while in flight, FAILED on a PSP-definitive answer. */
export function statusOfUnpostedFunding(state: string): HistoryStatus {
  if (!isFundingState(state)) throw new InvariantViolationError(`Unknown funding state ${state}.`);
  const status = fundingStatusOf(state as FundingState);
  // An unposted funding cannot be COMPLETED or REVERSED: those have a transaction row.
  if (status !== 'PENDING' && status !== 'FAILED') {
    throw new InvariantViolationError(`A funding in state ${state} has no transaction.`, { state });
  }
  return status;
}

/** Who started it, without identities (Phase 8 decision 11: operator ids are staff PII, job names internal). */
export type HistoryInitiator = 'USER' | 'SYSTEM' | 'OPERATOR';

export function initiatorOf(initiatedBy: string): HistoryInitiator {
  if (initiatedBy.startsWith('user:')) return 'USER';
  if (initiatedBy.startsWith('job:')) return 'SYSTEM';
  if (initiatedBy.startsWith('operator:')) return 'OPERATOR';
  throw new InvariantViolationError('Unknown initiator form.', { initiatedBy: initiatedBy.split(':')[0] });
}

/** Transaction types a history can be filtered by — those that exist in the books today. */
export const HISTORY_TYPES = [
  TransactionType.FUNDING,
  TransactionType.CONVERSION,
  TransactionType.REVERSAL,
  TransactionType.CORRECTION,
  TransactionType.PROMOTIONAL,
  TransactionType.WRITE_OFF,
] as const;

/**
 * Public, stable reason codes (Phase 8 decision 11). Clients may branch on them; renaming one is
 * a breaking API change (pinned by `transaction.view.spec.ts`).
 */
export const PUBLIC_REASON_CODES = [
  'CARD_DEPOSIT',
  'CHARGEBACK',
  'MARKET_CONVERSION',
  'QUOTED_TRADE',
  'SIGNUP_DEMO_CREDIT',
  // Phase 10: approved corrections and write-offs a user can see in their own history.
  'CLEARING_REATTRIBUTION',
  'SETTLEMENT_AMOUNT_CORRECTION',
  'PARTIAL_CHARGEBACK',
  'WRITE_OFF',
] as const;
