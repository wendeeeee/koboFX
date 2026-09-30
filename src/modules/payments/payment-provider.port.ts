import { Money } from '../../common/money';

/**
 * A payment's status as the PSP's API reports it (design §7.5). Only these values are
 * accepted at the boundary; anything else fails loudly (handbook: don't trust the schema).
 */
export enum ProviderPaymentStatus {
  AUTHORIZED = 'AUTHORIZED',
  CAPTURE_PENDING = 'CAPTURE_PENDING',
  CAPTURED = 'CAPTURED',
  DECLINED = 'DECLINED',
  EXPIRED = 'EXPIRED',
  VOIDED = 'VOIDED',
  CAPTURE_FAILED = 'CAPTURE_FAILED',
  CHARGED_BACK = 'CHARGED_BACK',
}

export interface ProviderChargeback {
  readonly chargebackId: string;
  readonly amount: Money;
  readonly createdAt: Date;
}

/** The fields of a PSP payment we use — and only those (design §7.2 point 1). */
export interface ProviderPayment {
  readonly paymentId: string;
  /** Our reference: the funding flow id. */
  readonly reference: string;
  readonly status: ProviderPaymentStatus;
  readonly amount: Money;
  readonly capturedAt: Date | null;
  readonly declineCode: string | null;
  readonly chargeback: ProviderChargeback | null;
}

/** Links every provider call to the flow it serves, for `provider_calls`. */
export interface ProviderCallContext {
  readonly flowId?: string;
}

export interface AuthorizePaymentRequest {
  readonly reference: string;
  readonly amount: Money;
  /** A single-use token from the PSP's client SDK. Never card data. */
  readonly paymentMethodToken: string;
  readonly idempotencyKey: string;
}

/** One page of a PSP list; `nextCursor` null = the last page. */
export interface ProviderPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** A settlement batch as listed (Phase 9): only `PAID` batches have moved money. */
export interface ProviderSettlementBatchSummary {
  readonly batchId: string;
  readonly currency: string;
  readonly status: 'PAID' | 'PENDING';
  readonly settledAt: Date;
}

export enum ProviderSettlementLineType {
  PAYMENT = 'PAYMENT',
  CHARGEBACK = 'CHARGEBACK',
}

/**
 * One line of a settlement report: a captured payment the PSP pays out (gross `amount`, its
 * `fee`), or a chargeback it deducts (`amount`, and the chargeback `fee`). Amounts are the
 * PSP's, in minor units — we never round them.
 */
export interface ProviderSettlementLine {
  readonly lineId: string;
  readonly type: ProviderSettlementLineType;
  readonly paymentId: string;
  readonly chargebackId: string | null;
  /** The line's own currency, as the PSP states it (must equal the batch's). */
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly feeMinor: bigint;
}

/**
 * A whole settlement report — header and every line, re-assembled from its pages. The totals
 * are what the PSP SAYS; whether the lines add up to them is checked by us, not trusted.
 */
export interface ProviderSettlementBatch {
  readonly batchId: string;
  readonly currency: string;
  readonly status: 'PAID' | 'PENDING';
  readonly settledAt: Date;
  readonly grossMinor: bigint;
  readonly feeMinor: bigint;
  readonly chargebackMinor: bigint;
  /** May be negative: chargebacks and fees exceeding payments (the PSP debited us). */
  readonly netMinor: bigint;
  readonly lineCount: number;
  readonly lines: readonly ProviderSettlementLine[];
  /** `provider_calls` rows holding the raw text of every page read (the evidence). */
  readonly providerCallIds: readonly string[];
}

export interface SettlementListQuery {
  readonly settledFrom: Date;
  readonly settledTo: Date;
  readonly cursor?: string;
}

/** A chargeback (dispute) as the PSP lists it, by its OWN creation date. */
export interface ProviderChargebackRecord {
  readonly chargebackId: string;
  readonly paymentId: string;
  readonly amount: Money;
  readonly createdAt: Date;
}

export interface ChargebackListQuery {
  readonly createdFrom: Date;
  readonly createdTo: Date;
  readonly cursor?: string;
}

export interface PaymentListQuery {
  readonly createdFrom: Date;
  readonly createdTo: Date;
  readonly cursor?: string;
}

/**
 * The PSP port (design §7.2, §14 `payments/`). Adapters own the transport; callers own
 * the meaning.
 *
 * - Reads (`getPayment`, `findPaymentByReference`) are idempotent and retried with
 *   backoff and full jitter.
 * - Writes (`authorize`, `capture`, `void`) are sent ONCE, each with a PSP idempotency
 *   key. A write that times out has an unknown outcome: the caller recovers by reading
 *   (and, if the read shows nothing happened, re-sending with the same key) — never by
 *   blindly re-issuing (design §7.5 rule 3).
 * - Every attempt is recorded in `provider_calls`, redacted.
 */
export abstract class PaymentProvider {
  abstract readonly name: string;
  abstract authorize(request: AuthorizePaymentRequest, context: ProviderCallContext): Promise<ProviderPayment>;
  abstract capture(paymentId: string, amount: Money, idempotencyKey: string, context: ProviderCallContext): Promise<ProviderPayment>;
  abstract void(paymentId: string, idempotencyKey: string, context: ProviderCallContext): Promise<ProviderPayment>;
  abstract getPayment(paymentId: string, context: ProviderCallContext): Promise<ProviderPayment>;
  abstract findPaymentByReference(reference: string, context: ProviderCallContext): Promise<ProviderPayment | null>;
  /** `null` when the PSP says it has no such payment (a 404) — the "missing at the PSP" fact. */
  abstract findPayment(paymentId: string, context: ProviderCallContext): Promise<ProviderPayment | null>;

  // ── reconciliation reads (Phase 9): retried, recorded, never a write ────────
  /** Payments created in `[createdFrom, createdTo)`, one page at a time. */
  abstract listPayments(query: PaymentListQuery): Promise<ProviderPage<ProviderPayment>>;
  /**
   * Chargebacks created in `[createdFrom, createdTo)`, one page at a time — by the DISPUTE's date:
   * a chargeback lands weeks or months after its payment, far outside any payment lookback.
   */
  abstract listChargebacks(query: ChargebackListQuery): Promise<ProviderPage<ProviderChargebackRecord>>;
  /** Settlement batches settled in `[settledFrom, settledTo)`, one page at a time. */
  abstract listSettlementBatches(query: SettlementListQuery): Promise<ProviderPage<ProviderSettlementBatchSummary>>;
  /** One report, every line page read and re-assembled; the raw text of each page is recorded. */
  abstract getSettlementBatch(batchId: string): Promise<ProviderSettlementBatch>;
}
