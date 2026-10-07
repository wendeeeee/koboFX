import { InvariantViolationError } from '../../common/errors';
import { FundingState, fundingStatusOf, isFundingState } from '../flows/funding/funding-transitions';
import { PAYSTACK_WITHDRAWAL_HOLDING_STATES, PaystackWithdrawalState } from '../flows/paystack-withdrawal/paystack-withdrawal-transitions';
import { TransactionStatus, TransactionType } from '../ledger/ledger.types';


export type HistoryStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERSED';


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

export function statusOfUnpostedFunding(state: string): HistoryStatus {
  if (!isFundingState(state)) throw new InvariantViolationError(`Unknown funding state ${state}.`);
  const status = fundingStatusOf(state as FundingState);
  if (status !== 'PENDING' && status !== 'FAILED') {
    throw new InvariantViolationError(`A funding in state ${state} has no transaction.`, { state });
  }
  return status;
}

/**
 * An unposted withdrawal (WITHDRAWAL_PLAN.md §J): money still held (RESERVED, SUBMITTING, PROCESSING) is PENDING; a
 * withdrawal that FAILED before posting is FAILED. POSTED and REVERSED have a principal transaction, so they are never
 * read from the withdrawal branch.
 */
export function statusOfUnpostedWithdrawal(state: string): HistoryStatus {
  if ((PAYSTACK_WITHDRAWAL_HOLDING_STATES as readonly string[]).includes(state)) return 'PENDING';
  if (state === PaystackWithdrawalState.FAILED) return 'FAILED';
  throw new InvariantViolationError(`A withdrawal in state ${state} has no unposted history item.`, { state });
}


export type HistoryInitiator = 'USER' | 'SYSTEM' | 'OPERATOR';

export function initiatorOf(initiatedBy: string): HistoryInitiator {
  if (initiatedBy.startsWith('user:')) return 'USER';
  if (initiatedBy.startsWith('job:')) return 'SYSTEM';
  if (initiatedBy.startsWith('operator:')) return 'OPERATOR';
  throw new InvariantViolationError('Unknown initiator form.', { initiatedBy: initiatedBy.split(':')[0] });
}

export const HISTORY_TYPES = [
  TransactionType.FUNDING,
  TransactionType.CONVERSION,
  TransactionType.WITHDRAWAL,
  TransactionType.REVERSAL,
  TransactionType.CORRECTION,
  TransactionType.PROMOTIONAL,
  TransactionType.WRITE_OFF,
] as const;


export const PUBLIC_REASON_CODES = [
  'CARD_DEPOSIT',
  'CHARGEBACK',
  'MARKET_CONVERSION',
  'QUOTED_TRADE',
  'SIGNUP_DEMO_CREDIT',
  'CLEARING_REATTRIBUTION',
  'SETTLEMENT_AMOUNT_CORRECTION',
  'PARTIAL_CHARGEBACK',
  'WRITE_OFF',
  'PAYSTACK_WITHDRAWAL',
  'PAYSTACK_TRANSFER_REVERSED',
] as const;
