import { Money } from '../../common/money';


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

export interface ProviderPayment {
  readonly paymentId: string;
  readonly reference: string;
  readonly status: ProviderPaymentStatus;
  readonly amount: Money;
  readonly capturedAt: Date | null;
  readonly declineCode: string | null;
  readonly chargeback: ProviderChargeback | null;
}

export interface ProviderCallContext {
  readonly flowId?: string;
}

export interface AuthorizePaymentRequest {
  readonly reference: string;
  readonly amount: Money;
  readonly paymentMethodToken: string;
  readonly idempotencyKey: string;
}

export interface ProviderPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

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

export interface ProviderSettlementLine {
  readonly lineId: string;
  readonly type: ProviderSettlementLineType;
  readonly paymentId: string;
  readonly chargebackId: string | null;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly feeMinor: bigint;
}

export interface ProviderSettlementBatch {
  readonly batchId: string;
  readonly currency: string;
  readonly status: 'PAID' | 'PENDING';
  readonly settledAt: Date;
  readonly grossMinor: bigint;
  readonly feeMinor: bigint;
  readonly chargebackMinor: bigint;
  readonly netMinor: bigint;
  readonly lineCount: number;
  readonly lines: readonly ProviderSettlementLine[];
  readonly providerCallIds: readonly string[];
}

export interface SettlementListQuery {
  readonly settledFrom: Date;
  readonly settledTo: Date;
  readonly cursor?: string;
}

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


export abstract class PaymentProvider {
  abstract readonly name: string;
  abstract authorize(request: AuthorizePaymentRequest, context: ProviderCallContext): Promise<ProviderPayment>;
  abstract capture(paymentId: string, amount: Money, idempotencyKey: string, context: ProviderCallContext): Promise<ProviderPayment>;
  abstract void(paymentId: string, idempotencyKey: string, context: ProviderCallContext): Promise<ProviderPayment>;
  abstract getPayment(paymentId: string, context: ProviderCallContext): Promise<ProviderPayment>;
  abstract findPaymentByReference(reference: string, context: ProviderCallContext): Promise<ProviderPayment | null>;
  abstract findPayment(paymentId: string, context: ProviderCallContext): Promise<ProviderPayment | null>;

  
  abstract listPayments(query: PaymentListQuery): Promise<ProviderPage<ProviderPayment>>;

  abstract listChargebacks(query: ChargebackListQuery): Promise<ProviderPage<ProviderChargebackRecord>>;
  abstract listSettlementBatches(query: SettlementListQuery): Promise<ProviderPage<ProviderSettlementBatchSummary>>;
  abstract getSettlementBatch(batchId: string): Promise<ProviderSettlementBatch>;
}
