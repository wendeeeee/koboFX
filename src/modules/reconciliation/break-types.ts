export enum BreakType {
  MISSING_IN_LEDGER = 'MISSING_IN_LEDGER',
  PAYMENT_WITHOUT_FLOW = 'PAYMENT_WITHOUT_FLOW',
  MISSING_AT_PSP = 'MISSING_AT_PSP',
  AMOUNT_MISMATCH = 'AMOUNT_MISMATCH',
  CURRENCY_MISMATCH = 'CURRENCY_MISMATCH',
  UNSETTLED_PAST_WINDOW = 'UNSETTLED_PAST_WINDOW',
  UNATTRIBUTED_SETTLEMENT_LINE = 'UNATTRIBUTED_SETTLEMENT_LINE',
  DUPLICATE_SETTLEMENT_LINE = 'DUPLICATE_SETTLEMENT_LINE',
  CHARGEBACK_NOT_REVERSED = 'CHARGEBACK_NOT_REVERSED',
  UNMATCHED_WEBHOOK = 'UNMATCHED_WEBHOOK',
  SETTLEMENT_REPORT_REJECTED = 'SETTLEMENT_REPORT_REJECTED',
  SETTLEMENT_BATCH_CHANGED = 'SETTLEMENT_BATCH_CHANGED',
  SETTLEMENT_IN_LOCKED_PERIOD = 'SETTLEMENT_IN_LOCKED_PERIOD',
  RECEIVABLE_PROOF_FAILED = 'RECEIVABLE_PROOF_FAILED',
  TRIAL_BALANCE_UNBALANCED = 'TRIAL_BALANCE_UNBALANCED',
  ACCOUNTING_EQUATION_FAILED = 'ACCOUNTING_EQUATION_FAILED',
  CACHED_BALANCE_DRIFT = 'CACHED_BALANCE_DRIFT',
  BALANCE_CONTINUITY_BREAK = 'BALANCE_CONTINUITY_BREAK',
  HASH_CHAIN_BREAK = 'HASH_CHAIN_BREAK',
  RESERVED_BALANCE_DRIFT = 'RESERVED_BALANCE_DRIFT',
  FX_PROVENANCE_MISMATCH = 'FX_PROVENANCE_MISMATCH',
  // Withdrawals W4 (WITHDRAWAL_PLAN.md §I.2): owned by (paystack, TRANSFER).
  /** A successful Paystack transfer no withdrawal of ours explains (never a debit to a guessed user or stash). */
  TRANSFER_WITHOUT_INTENT = 'TRANSFER_WITHOUT_INTENT',
  /** A transfer under one of our references whose identity (amount, currency, recipient, domain, ids) differs. */
  TRANSFER_IDENTITY_MISMATCH = 'TRANSFER_IDENTITY_MISMATCH',
  /** A withdrawal still unresolved past the review threshold (provider lag first: investigate). */
  WITHDRAWAL_NOT_POSTED = 'WITHDRAWAL_NOT_POSTED',
  /** Paystack reports a posted withdrawal reversed, and the principal return is not booked. */
  WITHDRAWAL_RETURN_NOT_POSTED = 'WITHDRAWAL_RETURN_NOT_POSTED',
  /** A protected hold whose flow is terminal or missing (or a withdrawal whose hold disagrees with its state). */
  WITHDRAWAL_RESERVATION_INCONSISTENT = 'WITHDRAWAL_RESERVATION_INCONSISTENT',
  /** Stash receipts and postings disagree (one confirmation per POSTED, one reversal per REVERSED, nets). */
  STASH_RECEIPT_INCONSISTENT = 'STASH_RECEIPT_INCONSISTENT',
  /** PAYSTACK_PAYOUT_IN_TRANSIT does not net to zero in a currency. */
  PAYOUT_BALANCE_PROOF_FAILED = 'PAYOUT_BALANCE_PROOF_FAILED',
  /** A posted withdrawal whose provider fee was never evidenced (null `fee_charged`): never booked as zero. */
  PAYOUT_FEE_EVIDENCE_MISSING = 'PAYOUT_FEE_EVIDENCE_MISSING',
  /** The payout balance is negative: the accepted D3 limitation (no evidenced treasury top-up), made visible. */
  PAYOUT_TREASURY_EVIDENCE_MISSING = 'PAYOUT_TREASURY_EVIDENCE_MISSING',
}

export const BREAK_TYPES: readonly BreakType[] = Object.values(BreakType);


export type BreakSeverity = 'MONEY' | 'SECURITY' | 'INVESTIGATE';

export interface BreakPolicy {
  readonly severity: BreakSeverity;
  readonly escalateOnDetection: boolean;
 
  readonly rederivedBy: 'INTERNAL' | 'EXTERNAL_DAILY' | null;
}

const money = (rederivedBy: BreakPolicy['rederivedBy']): BreakPolicy => ({ severity: 'MONEY', escalateOnDetection: true, rederivedBy });
const investigate = (rederivedBy: BreakPolicy['rederivedBy']): BreakPolicy => ({
  severity: 'INVESTIGATE',
  escalateOnDetection: false,
  rederivedBy,
});

export const BREAK_POLICIES: Readonly<Record<BreakType, BreakPolicy>> = {
  [BreakType.MISSING_IN_LEDGER]: investigate('EXTERNAL_DAILY'),
  [BreakType.PAYMENT_WITHOUT_FLOW]: money('EXTERNAL_DAILY'),
  [BreakType.MISSING_AT_PSP]: money('EXTERNAL_DAILY'),
  [BreakType.AMOUNT_MISMATCH]: money(null),
  [BreakType.CURRENCY_MISMATCH]: money(null),
  [BreakType.UNSETTLED_PAST_WINDOW]: investigate('EXTERNAL_DAILY'),
  [BreakType.UNATTRIBUTED_SETTLEMENT_LINE]: money(null),
  [BreakType.DUPLICATE_SETTLEMENT_LINE]: money(null),
  [BreakType.CHARGEBACK_NOT_REVERSED]: investigate('EXTERNAL_DAILY'),
  [BreakType.UNMATCHED_WEBHOOK]: investigate(null),
  [BreakType.SETTLEMENT_REPORT_REJECTED]: money(null),
  [BreakType.SETTLEMENT_BATCH_CHANGED]: money(null),
  [BreakType.SETTLEMENT_IN_LOCKED_PERIOD]: money(null),
  [BreakType.RECEIVABLE_PROOF_FAILED]: money('EXTERNAL_DAILY'),
  [BreakType.TRIAL_BALANCE_UNBALANCED]: money('INTERNAL'),
  [BreakType.ACCOUNTING_EQUATION_FAILED]: money('INTERNAL'),
  [BreakType.CACHED_BALANCE_DRIFT]: money('INTERNAL'),
  [BreakType.BALANCE_CONTINUITY_BREAK]: money('INTERNAL'),
  [BreakType.HASH_CHAIN_BREAK]: { severity: 'SECURITY', escalateOnDetection: true, rederivedBy: 'INTERNAL' },
  [BreakType.RESERVED_BALANCE_DRIFT]: money('INTERNAL'),
  [BreakType.FX_PROVENANCE_MISMATCH]: money('INTERNAL'),
  [BreakType.TRANSFER_WITHOUT_INTENT]: money('EXTERNAL_DAILY'),
  [BreakType.TRANSFER_IDENTITY_MISMATCH]: { severity: 'SECURITY', escalateOnDetection: true, rederivedBy: 'EXTERNAL_DAILY' },
  [BreakType.WITHDRAWAL_NOT_POSTED]: investigate(null),
  [BreakType.WITHDRAWAL_RETURN_NOT_POSTED]: money('EXTERNAL_DAILY'),
  [BreakType.WITHDRAWAL_RESERVATION_INCONSISTENT]: money('EXTERNAL_DAILY'),
  [BreakType.STASH_RECEIPT_INCONSISTENT]: money('EXTERNAL_DAILY'),
  [BreakType.PAYOUT_BALANCE_PROOF_FAILED]: money('EXTERNAL_DAILY'),
  [BreakType.PAYOUT_FEE_EVIDENCE_MISSING]: investigate('EXTERNAL_DAILY'),
  [BreakType.PAYOUT_TREASURY_EVIDENCE_MISSING]: investigate('EXTERNAL_DAILY'),
};

export const subjectKeys = {
  payment: (provider: string, paymentId: string) => `payment:${provider}:${paymentId}`,
  flow: (flowId: string) => `flow:${flowId}`,
  line: (provider: string, batchId: string, lineId: string) => `line:${provider}:${batchId}:${lineId}`,
  batch: (provider: string, batchId: string) => `batch:${provider}:${batchId}`,
  webhook: (webhookEventId: string) => `webhook:${webhookEventId}`,
  currency: (currency: string) => `currency:${currency}`,
  account: (accountId: string) => `account:${accountId}`,
  transaction: (transactionId: string) => `transaction:${transactionId}`,
  // Withdrawals W4: every one of these belongs to (paystack, TRANSFER) — see `BreakOwnership`.
  transfer: (provider: string, transferId: string) => `transfer:${provider}:${transferId}`,
  withdrawal: (flowId: string) => `withdrawal:${flowId}`,
  payoutBalance: (provider: string, currency: string) => `payout-balance:${provider}:${currency}`,
  stashReceipt: (subjectId: string) => `stash-receipt:${subjectId}`,
} as const;
