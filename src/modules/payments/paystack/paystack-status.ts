/**
 * Every Paystack transaction status we know (PAYSTACK_PLAN.md A3–A5), mapped EXPLICITLY. Anything else fails loudly
 * at the boundary (`parsePaystackStatus`): a status we have never seen is a broken assumption, never "probably fine".
 *
 * Meaning (Paystack docs and support articles, checked 2026-10-01):
 * - `success` — paid. The only status that can ever credit a user.
 * - `abandoned` — initialized, the customer has not completed (it is what verify returns right after initialize).
 * - `failed` — the last attempt failed; on the hosted checkout the customer may still retry the SAME transaction.
 * - `ongoing` — waiting on the customer (an OTP, a transfer).
 * - `pending`, `processing`, `queued` — Paystack is still working on it.
 * - `reversed` — reversed after the fact (no money for us).
 */
export enum PaystackTransactionStatus {
  SUCCESS = 'success',
  ABANDONED = 'abandoned',
  FAILED = 'failed',
  ONGOING = 'ongoing',
  PENDING = 'pending',
  PROCESSING = 'processing',
  QUEUED = 'queued',
  REVERSED = 'reversed',
}

export const PAYSTACK_TRANSACTION_STATUSES: readonly PaystackTransactionStatus[] = Object.values(PaystackTransactionStatus);

/** What a status means for a funding flow (PAYSTACK_PLAN.md C3). */
export enum PaystackStatusMeaning {
  /** Paid: credit, if every field matches. */
  PAID = 'PAID',
  /** Not paid, and no money is moving: definitive only after the checkout window (policy). */
  UNPAID = 'UNPAID',
  /** Money may be in flight: never definitive, whatever the time. */
  IN_FLIGHT = 'IN_FLIGHT',
  /** Reversed: no money for us; definitive. */
  REVERSED = 'REVERSED',
}

export const PAYSTACK_STATUS_MEANING: Readonly<Record<PaystackTransactionStatus, PaystackStatusMeaning>> = {
  [PaystackTransactionStatus.SUCCESS]: PaystackStatusMeaning.PAID,
  [PaystackTransactionStatus.ABANDONED]: PaystackStatusMeaning.UNPAID,
  [PaystackTransactionStatus.FAILED]: PaystackStatusMeaning.UNPAID,
  [PaystackTransactionStatus.ONGOING]: PaystackStatusMeaning.IN_FLIGHT,
  [PaystackTransactionStatus.PENDING]: PaystackStatusMeaning.IN_FLIGHT,
  [PaystackTransactionStatus.PROCESSING]: PaystackStatusMeaning.IN_FLIGHT,
  [PaystackTransactionStatus.QUEUED]: PaystackStatusMeaning.IN_FLIGHT,
  [PaystackTransactionStatus.REVERSED]: PaystackStatusMeaning.REVERSED,
};

export function isPaystackTransactionStatus(value: string): value is PaystackTransactionStatus {
  return (PAYSTACK_TRANSACTION_STATUSES as readonly string[]).includes(value);
}
