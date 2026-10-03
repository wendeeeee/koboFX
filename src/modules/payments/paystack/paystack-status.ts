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

export enum PaystackStatusMeaning {
  PAID = 'PAID',
  UNPAID = 'UNPAID',
  IN_FLIGHT = 'IN_FLIGHT',
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
