/**
 * The break taxonomy (Phase 9 plan §F): one type per kind of discrepancy, each with how bad it
 * is and how it may be resolved. The database enum `reconciliation_break_type` holds the same
 * values (a spec asserts they match).
 */
export enum BreakType {
  // External — our books against the PSP's (design §8.2).
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
  // Internal — the books against themselves (design §8.1).
  TRIAL_BALANCE_UNBALANCED = 'TRIAL_BALANCE_UNBALANCED',
  ACCOUNTING_EQUATION_FAILED = 'ACCOUNTING_EQUATION_FAILED',
  CACHED_BALANCE_DRIFT = 'CACHED_BALANCE_DRIFT',
  BALANCE_CONTINUITY_BREAK = 'BALANCE_CONTINUITY_BREAK',
  HASH_CHAIN_BREAK = 'HASH_CHAIN_BREAK',
  RESERVED_BALANCE_DRIFT = 'RESERVED_BALANCE_DRIFT',
  FX_PROVENANCE_MISMATCH = 'FX_PROVENANCE_MISMATCH',
}

export const BREAK_TYPES: readonly BreakType[] = Object.values(BreakType);

/**
 * - `MONEY`: money is wrong or unaccounted for — counts toward `reconciliation_drift_minor`
 *   (pages), escalated at detection (only a Phase 10 CORRECTION or a human resolves it).
 * - `SECURITY`: someone edited the database directly (§16 "Hash chain broken": page security).
 * - `INVESTIGATE`: a liveness or timing problem; an automatic resolution is tried first.
 */
export type BreakSeverity = 'MONEY' | 'SECURITY' | 'INVESTIGATE';

export interface BreakPolicy {
  readonly severity: BreakSeverity;
  /** Created ESCALATED rather than OPEN: nothing automatic can resolve it. */
  readonly escalateOnDetection: boolean;
  /**
   * Re-derived in full by every run of its kind: when such a run no longer sees a live break
   * and nothing named its cause, the break is escalated as "no longer detected" — never
   * silently resolved. One-off events (a settlement line, a report) are not re-derived.
   */
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
};

/** The subject keys — one live break per `(type, subject)`. Stable: they are the dedupe key. */
export const subjectKeys = {
  payment: (provider: string, paymentId: string) => `payment:${provider}:${paymentId}`,
  flow: (flowId: string) => `flow:${flowId}`,
  line: (provider: string, batchId: string, lineId: string) => `line:${provider}:${batchId}:${lineId}`,
  batch: (provider: string, batchId: string) => `batch:${provider}:${batchId}`,
  webhook: (webhookEventId: string) => `webhook:${webhookEventId}`,
  currency: (currency: string) => `currency:${currency}`,
  account: (accountId: string) => `account:${accountId}`,
  transaction: (transactionId: string) => `transaction:${transactionId}`,
} as const;
