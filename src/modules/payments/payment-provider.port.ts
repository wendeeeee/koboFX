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
}
