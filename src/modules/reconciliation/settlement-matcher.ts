import { createHash } from 'node:crypto';
import {
  ProviderSettlementBatch,
  ProviderSettlementLine,
  ProviderSettlementLineType,
} from '../payments/payment-provider.port';
import { BreakType, subjectKeys } from './break-types';

/** What we booked for one PSP payment — the matcher's view of `funding_payments`. */
export interface KnownDeposit {
  readonly flowId: string;
  readonly providerPaymentId: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  /** The funding is in the ledger (`funding_transaction_id` set). */
  readonly posted: boolean;
  /**
   * What our chargeback posting took from `PSP_RECEIVABLE` (Phase 10): the full amount for a reversal, the
   * disputed part for an approved partial-chargeback CORRECTION. Absent = no chargeback booked against the
   * receivable — a deduction line is then expected to equal the deposit (a full chargeback).
   */
  readonly bookedChargebackMinor?: bigint;
}

/** What the PSP's own API says about a payment id we have no deposit for. */
export type PaymentLookup =
  /** The PSP 404s its own line: nobody can say whose money this is. */
  | { readonly kind: 'UNKNOWN' }
  /** The PSP has it under a reference that is no flow of ours: a payment we never saw. */
  | { readonly kind: 'FOREIGN'; readonly reference: string };

export interface MatchInput {
  readonly provider: string;
  readonly batch: ProviderSettlementBatch;
  /** By PSP payment id. */
  readonly deposits: ReadonlyMap<string, KnownDeposit>;
  /** Payment ids an EARLIER batch already settled (attributed). */
  readonly settledPaymentIds: ReadonlySet<string>;
  /** Chargeback ids an EARLIER batch already deducted (attributed). */
  readonly deductedChargebackIds: ReadonlySet<string>;
  /** For every payment id with no deposit: the PSP's answer. */
  readonly lookups: ReadonlyMap<string, PaymentLookup>;
  /** Currencies we hold accounts in (a `CLEARING` / `BANK` account exists). */
  readonly activeCurrencies: ReadonlySet<string>;
}

/** A discrepancy, ready to become a break. Details carry ids and amounts only (strings). */
export interface DetectedDiscrepancy {
  readonly type: BreakType;
  readonly subjectKey: string;
  readonly currency: string | null;
  readonly amountMinor: bigint;
  readonly flowId?: string;
  readonly providerPaymentId?: string;
  /** The PSP's line id; the job maps it to the stored line row. */
  readonly providerLineId?: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export type LineAttribution = 'ATTRIBUTED' | 'CLEARING';

export interface LineDecision {
  readonly line: ProviderSettlementLine;
  readonly attribution: LineAttribution;
  /** The deposit's flow, when the line names one of ours (even if the money went to CLEARING). */
  readonly flowId: string | null;
  readonly discrepancy: DetectedDiscrepancy | null;
}

export enum SettlementRejection {
  EMPTY = 'EMPTY',
  INVALID_LINE_AMOUNT = 'INVALID_LINE_AMOUNT',
  UNSUPPORTED_CURRENCY = 'UNSUPPORTED_CURRENCY',
  MIXED_CURRENCY = 'MIXED_CURRENCY',
  LINE_COUNT_MISMATCH = 'LINE_COUNT_MISMATCH',
  DUPLICATE_LINE_ID = 'DUPLICATE_LINE_ID',
  TOTALS_MISMATCH = 'TOTALS_MISMATCH',
  PERIOD_LOCKED = 'PERIOD_LOCKED',
}

export type MatchResult =
  | { readonly kind: 'ACCEPTED'; readonly lines: readonly LineDecision[] }
  | { readonly kind: 'REJECTED'; readonly code: SettlementRejection; readonly discrepancy: DetectedDiscrepancy | null };

/** Σ of one kind of line. */
function sum(lines: readonly ProviderSettlementLine[], pick: (line: ProviderSettlementLine) => bigint): bigint {
  return lines.reduce((total, line) => total + pick(line), 0n);
}

/**
 * Whether a report can be posted at all: it names a currency we hold, every line is in it, the
 * line count and ids are what the header says, and the lines add up to EVERY stated total —
 * including `net = gross − fees − chargebacks`. The PSP's totals are what it says, never what we
 * assume (handbook: no trust). `null` = postable.
 */
export function validateSettlementReport(
  batch: ProviderSettlementBatch,
  activeCurrencies: ReadonlySet<string>,
): SettlementRejection | null {
  if (batch.lines.length === 0 && batch.lineCount === 0) return SettlementRejection.EMPTY;
  if (!activeCurrencies.has(batch.currency)) return SettlementRejection.UNSUPPORTED_CURRENCY;
  if (batch.lines.some((line) => line.amountMinor <= 0n || line.feeMinor < 0n)) return SettlementRejection.INVALID_LINE_AMOUNT;
  if (batch.lines.some((line) => line.currency !== batch.currency)) return SettlementRejection.MIXED_CURRENCY;
  if (batch.lines.length !== batch.lineCount) return SettlementRejection.LINE_COUNT_MISMATCH;
  if (new Set(batch.lines.map((line) => line.lineId)).size !== batch.lines.length) return SettlementRejection.DUPLICATE_LINE_ID;
  const payments = batch.lines.filter((line) => line.type === ProviderSettlementLineType.PAYMENT);
  const chargebacks = batch.lines.filter((line) => line.type === ProviderSettlementLineType.CHARGEBACK);
  const addsUp =
    sum(payments, (line) => line.amountMinor) === batch.grossMinor &&
    sum(chargebacks, (line) => line.amountMinor) === batch.chargebackMinor &&
    sum(batch.lines, (line) => line.feeMinor) === batch.feeMinor &&
    batch.netMinor === batch.grossMinor - batch.feeMinor - batch.chargebackMinor;
  return addsUp ? null : SettlementRejection.TOTALS_MISMATCH;
}

/**
 * The matching engine (design §8.2; handbook: reconciliation — matching, one-to-many). Pure and
 * deterministic: the same inputs give the same decisions (lines are taken in line-id order).
 *
 * The key is the PSP's own id — `provider_payment_id` for a payment line, the dispute id for a
 * chargeback line — NEVER amount-and-time. A line is ATTRIBUTED (its money discharges
 * `PSP_RECEIVABLE`) only when it names a deposit of ours that is booked, in the batch's currency,
 * for exactly the booked amount, and settled (or deducted) for the first time. Anything else
 * goes to `CLEARING` with exactly ONE discrepancy — its money is real (it moved at the bank) but
 * we cannot say whose it is.
 */
export function matchSettlementBatch(input: MatchInput): MatchResult {
  const { batch, provider } = input;
  const rejection = validateSettlementReport(batch, input.activeCurrencies);
  if (rejection !== null) {
    return {
      kind: 'REJECTED',
      code: rejection,
      discrepancy:
        rejection === SettlementRejection.EMPTY
          ? null
          : reportRejected(provider, batch, rejection),
    };
  }

  const seenPayments = new Set<string>();
  const seenChargebacks = new Set<string>();
  const lines = [...batch.lines].sort((a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0));
  const decisions = lines.map((line): LineDecision => {
    const deposit = input.deposits.get(line.paymentId);
    const clearing = (discrepancy: DetectedDiscrepancy): LineDecision => ({
      line,
      attribution: 'CLEARING',
      flowId: deposit?.flowId ?? null,
      discrepancy,
    });
    const lineFacts = {
      batchId: batch.batchId,
      lineId: line.lineId,
      lineType: line.type,
      lineAmountMinor: line.amountMinor.toString(),
    };

    // One money movement per PSP id, ever: a repeat — in this batch or an earlier one — is a duplicate.
    const repeated =
      line.type === ProviderSettlementLineType.PAYMENT
        ? seenPayments.has(line.paymentId) || input.settledPaymentIds.has(line.paymentId)
        : seenChargebacks.has(line.chargebackId ?? '') || input.deductedChargebackIds.has(line.chargebackId ?? '');
    if (line.type === ProviderSettlementLineType.PAYMENT) seenPayments.add(line.paymentId);
    else seenChargebacks.add(line.chargebackId ?? '');
    if (repeated) {
      return clearing({
        type: BreakType.DUPLICATE_SETTLEMENT_LINE,
        subjectKey: subjectKeys.line(provider, batch.batchId, line.lineId),
        currency: batch.currency,
        amountMinor: line.amountMinor,
        providerPaymentId: line.paymentId,
        providerLineId: line.lineId,
        ...(deposit ? { flowId: deposit.flowId } : {}),
        details: { ...lineFacts, providerPaymentId: line.paymentId, chargebackId: line.chargebackId },
      });
    }

    if (!deposit) {
      const lookup = input.lookups.get(line.paymentId) ?? { kind: 'UNKNOWN' };
      if (lookup.kind === 'FOREIGN') {
        return clearing({
          type: BreakType.PAYMENT_WITHOUT_FLOW,
          subjectKey: subjectKeys.payment(provider, line.paymentId),
          currency: batch.currency,
          amountMinor: line.amountMinor,
          providerPaymentId: line.paymentId,
          providerLineId: line.lineId,
          details: { ...lineFacts, providerPaymentId: line.paymentId, source: 'SETTLEMENT_LINE' },
        });
      }
      return clearing({
        type: BreakType.UNATTRIBUTED_SETTLEMENT_LINE,
        subjectKey: subjectKeys.line(provider, batch.batchId, line.lineId),
        currency: batch.currency,
        amountMinor: line.amountMinor,
        providerPaymentId: line.paymentId,
        providerLineId: line.lineId,
        details: { ...lineFacts, providerPaymentId: line.paymentId },
      });
    }

    const depositFacts = {
      ...lineFacts,
      providerPaymentId: line.paymentId,
      bookedCurrency: deposit.currency,
      bookedAmountMinor: deposit.amountMinor.toString(),
    };
    if (deposit.currency !== batch.currency) {
      return clearing({
        type: BreakType.CURRENCY_MISMATCH,
        subjectKey: subjectKeys.payment(provider, line.paymentId),
        currency: batch.currency,
        amountMinor: line.amountMinor,
        flowId: deposit.flowId,
        providerPaymentId: line.paymentId,
        providerLineId: line.lineId,
        details: { ...depositFacts, lineCurrency: batch.currency },
      });
    }
    if (!deposit.posted) {
      return clearing({
        type: BreakType.MISSING_IN_LEDGER,
        subjectKey: subjectKeys.payment(provider, line.paymentId),
        currency: batch.currency,
        amountMinor: line.amountMinor,
        flowId: deposit.flowId,
        providerPaymentId: line.paymentId,
        providerLineId: line.lineId,
        details: { ...depositFacts, source: 'SETTLEMENT_LINE', settledIntoClearing: true },
      });
    }
    // A deduction is attributed when it equals what we booked for the chargeback (a partial one, once its approved
    // CORRECTION posted it against the receivable) — else the deposit's amount, a full chargeback.
    const expectedMinor = line.type === ProviderSettlementLineType.CHARGEBACK ? (deposit.bookedChargebackMinor ?? deposit.amountMinor) : deposit.amountMinor;
    if (line.amountMinor !== expectedMinor) {
      // A chargeback for less than the deposit is a PARTIAL chargeback (Phase 5: parked for a
      // Phase 10 CORRECTION). Its break is the flow's — the same one the payment check raises.
      if (line.type === ProviderSettlementLineType.CHARGEBACK) {
        return clearing({
          type: BreakType.CHARGEBACK_NOT_REVERSED,
          subjectKey: subjectKeys.flow(deposit.flowId),
          currency: batch.currency,
          amountMinor: line.amountMinor,
          flowId: deposit.flowId,
          providerPaymentId: line.paymentId,
          providerLineId: line.lineId,
          details: { ...depositFacts, chargebackId: line.chargebackId, partial: true },
        });
      }
      return clearing({
        type: BreakType.AMOUNT_MISMATCH,
        subjectKey: subjectKeys.payment(provider, line.paymentId),
        currency: batch.currency,
        amountMinor: line.amountMinor,
        flowId: deposit.flowId,
        providerPaymentId: line.paymentId,
        providerLineId: line.lineId,
        details: depositFacts,
      });
    }
    return { line, attribution: 'ATTRIBUTED', flowId: deposit.flowId, discrepancy: null };
  });
  return { kind: 'ACCEPTED', lines: decisions };
}

function reportRejected(provider: string, batch: ProviderSettlementBatch, code: SettlementRejection): DetectedDiscrepancy {
  return {
    type: code === SettlementRejection.PERIOD_LOCKED ? BreakType.SETTLEMENT_IN_LOCKED_PERIOD : BreakType.SETTLEMENT_REPORT_REJECTED,
    subjectKey: subjectKeys.batch(provider, batch.batchId),
    currency: batch.currency,
    amountMinor: batch.netMinor < 0n ? -batch.netMinor : batch.netMinor,
    details: {
      batchId: batch.batchId,
      rejection: code,
      grossMinor: batch.grossMinor.toString(),
      feeMinor: batch.feeMinor.toString(),
      chargebackMinor: batch.chargebackMinor.toString(),
      netMinor: batch.netMinor.toString(),
      lineCount: batch.lineCount,
      reportCurrency: batch.currency,
    },
  };
}

/** The break for a report `post()` refused because its settlement date is in a locked period. */
export function lockedPeriodDiscrepancy(provider: string, batch: ProviderSettlementBatch): DetectedDiscrepancy {
  return reportRejected(provider, batch, SettlementRejection.PERIOD_LOCKED);
}

/**
 * The canonical content of a report, hashed: header + lines in line-id order. Two reads with
 * the same hash are the same report; a different hash for a batch id we already ingested is a
 * report that changed after we read it (never re-posted, never edited: a new version + a break).
 */
export function settlementContentHash(batch: ProviderSettlementBatch): string {
  const lines = [...batch.lines]
    .sort((a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0))
    .map((line) => [
      line.lineId,
      line.type,
      line.paymentId,
      line.chargebackId,
      line.currency,
      line.amountMinor.toString(),
      line.feeMinor.toString(),
    ]);
  const canonical = JSON.stringify([
    'v1',
    batch.batchId,
    batch.currency,
    batch.status,
    batch.settledAt.toISOString(),
    batch.grossMinor.toString(),
    batch.feeMinor.toString(),
    batch.chargebackMinor.toString(),
    batch.netMinor.toString(),
    batch.lineCount,
    lines,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
