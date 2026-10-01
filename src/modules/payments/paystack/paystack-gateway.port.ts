import { Money } from '../../../common/money';
import { ProviderCallContext, ProviderPage } from '../payment-provider.port';
import { PaystackTransactionStatus } from './paystack-status';

/** The checkout Paystack created for one of our references (initialize). */
export interface PaystackCheckout {
  readonly authorizationUrl: string;
  readonly accessCode: string;
  readonly reference: string;
}

/** The fields of a Paystack transaction we use — and only those. */
export interface PaystackTransaction {
  /** Paystack's integer id, as decimal text (never through a float). */
  readonly transactionId: string;
  /** Our reference: the funding flow id. */
  readonly reference: string;
  readonly status: PaystackTransactionStatus;
  /** What Paystack says was charged (`amount`, subunits) in `currency`. */
  readonly amount: Money;
  readonly paidAt: Date | null;
  readonly createdAt: Date | null;
  /** Paystack's human text ("Successful", "Declined"): diagnostics only. */
  readonly gatewayResponse: string | null;
}

export interface PaystackDispute {
  readonly disputeId: string;
  readonly transactionId: string;
  readonly transactionReference: string | null;
  readonly status: string;
  /** `merchant-accepted` | `declined` | null (unresolved). */
  readonly resolution: string | null;
  /** The amount disputed (`refund_amount`), when Paystack states it. */
  readonly refundAmount: Money | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

export interface InitializeTransactionRequest {
  readonly reference: string;
  readonly amount: Money;
  /** The authenticated user's stored email (personal data sent to Paystack as processor). Never logged. */
  readonly email: string;
  readonly callbackUrl: string;
  readonly metadata: Record<string, string>;
}

export interface PaystackListQuery {
  readonly from: Date;
  readonly to: Date;
  /** The page to read (Paystack paginates by page number); undefined = the first. */
  readonly cursor?: string;
}

/**
 * The Paystack port (PAYSTACK_PLAN.md E). Its own port — Paystack has no authorize/capture split, so it does not
 * pretend to be the PSP port.
 *
 * - `initialize` is a write: sent ONCE per attempt (Paystack has no idempotency key; OUR reference is the dedupe — a
 *   re-sent reference is refused with `PaystackDuplicateReferenceError`, and the caller reads back with `verify`).
 * - Reads (`verify`, lists) are retried with full jitter. `verify` returns `null` when Paystack has no such reference.
 * - Every attempt is recorded in `provider_calls`, redacted, every digit kept; the key is never recorded.
 */
export abstract class PaystackGateway {
  abstract readonly name: string;
  abstract initialize(request: InitializeTransactionRequest, context: ProviderCallContext): Promise<PaystackCheckout>;
  abstract verify(reference: string, context: ProviderCallContext): Promise<PaystackTransaction | null>;
  /** Transactions created in `[from, to]` as Paystack filters them (inclusivity unverified: callers re-filter). */
  abstract listTransactions(query: PaystackListQuery): Promise<ProviderPage<PaystackTransaction>>;
  abstract listDisputes(query: PaystackListQuery & { readonly transactionId?: string }): Promise<ProviderPage<PaystackDispute>>;
}
