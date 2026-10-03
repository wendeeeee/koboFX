import { Money } from '../../../common/money';
import { ProviderCallContext, ProviderPage } from '../payment-provider.port';
import { PaystackTransactionStatus } from './paystack-status';

export interface PaystackCheckout {
  readonly authorizationUrl: string;
  readonly accessCode: string;
  readonly reference: string;
}

export interface PaystackTransaction {
  readonly transactionId: string;
  readonly reference: string;
  readonly status: PaystackTransactionStatus;
  readonly amount: Money;
  readonly paidAt: Date | null;
  readonly createdAt: Date | null;
  readonly gatewayResponse: string | null;
}

export interface PaystackDispute {
  readonly disputeId: string;
  readonly transactionId: string;
  readonly transactionReference: string | null;
  readonly status: string;
  readonly resolution: string | null;
  readonly refundAmount: Money | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

export interface InitializeTransactionRequest {
  readonly reference: string;
  readonly amount: Money;
  readonly email: string;
  readonly callbackUrl: string;
  readonly metadata: Record<string, string>;
}

export interface PaystackListQuery {
  readonly from: Date;
  readonly to: Date;
  readonly cursor?: string;
}

export abstract class PaystackGateway {
  abstract readonly name: string;
  abstract initialize(request: InitializeTransactionRequest, context: ProviderCallContext): Promise<PaystackCheckout>;
  abstract verify(reference: string, context: ProviderCallContext): Promise<PaystackTransaction | null>;
  abstract listTransactions(query: PaystackListQuery): Promise<ProviderPage<PaystackTransaction>>;
  abstract listDisputes(query: PaystackListQuery & { readonly transactionId?: string }): Promise<ProviderPage<PaystackDispute>>;
}
