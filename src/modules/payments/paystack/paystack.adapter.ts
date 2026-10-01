import { ProviderCallContext, ProviderPage } from '../payment-provider.port';
import { ProviderRequestRejectedError } from '../payment.errors';
import {
  InitializeTransactionRequest,
  PaystackCheckout,
  PaystackDispute,
  PaystackGateway,
  PaystackListQuery,
  PaystackTransaction,
} from './paystack-gateway.port';
import { PaystackHttpClient, PaystackRefusal } from './paystack-http-client';
import { parseCheckout, parseDisputePage, parseTransaction, parseTransactionPage } from './paystack-responses';
import { PaystackDuplicateReferenceError } from './paystack.errors';

const PAGE_SIZE = 100;

/**
 * The Paystack adapter (https://paystack.com/docs/api). Only the four calls we use: initialize, verify, list
 * transactions, list disputes. The amount goes out as a digit string (Paystack documents `amount` as a String in the
 * subunit) — never a float; it comes back as a JSON number, read losslessly.
 */
export class PaystackAdapter extends PaystackGateway {
  constructor(
    readonly name: string,
    private readonly client: PaystackHttpClient,
  ) {
    super();
  }

  async initialize(request: InitializeTransactionRequest, context: ProviderCallContext): Promise<PaystackCheckout> {
    let body: unknown;
    try {
      body = await this.client.send({
        operation: 'initialize',
        method: 'POST',
        path: '/transaction/initialize',
        flowId: context.flowId,
        body: {
          email: request.email,
          amount: request.amount.toMinorString(),
          currency: request.amount.currency,
          reference: request.reference,
          callback_url: request.callbackUrl,
          metadata: request.metadata,
          channels: ['card'],
        },
      });
    } catch (error) {
      if (error instanceof ProviderRequestRejectedError && error.providerErrorCode === PaystackRefusal.DUPLICATE_REFERENCE) {
        throw new PaystackDuplicateReferenceError(request.reference);
      }
      throw error;
    }
    const checkout = parseCheckout(body, 'initialize');
    if (checkout.reference !== request.reference) {
      throw new PaystackDuplicateReferenceError(request.reference, `Paystack answered initialize ${request.reference} with ${checkout.reference}.`);
    }
    return checkout;
  }

  async verify(reference: string, context: ProviderCallContext): Promise<PaystackTransaction | null> {
    let body: unknown;
    try {
      body = await this.client.send({
        operation: 'verify',
        method: 'GET',
        path: `/transaction/verify/${encodeURIComponent(reference)}`,
        flowId: context.flowId,
      });
    } catch (error) {
      if (error instanceof ProviderRequestRejectedError && error.providerErrorCode === PaystackRefusal.REFERENCE_NOT_FOUND) return null;
      throw error;
    }
    return parseTransaction(body, 'verify');
  }

  async listTransactions(query: PaystackListQuery): Promise<ProviderPage<PaystackTransaction>> {
    const body = await this.client.send({
      operation: 'list-transactions',
      method: 'GET',
      path: `/transaction?${listQuery(query)}`,
    });
    return parseTransactionPage(body, 'list-transactions');
  }

  async listDisputes(query: PaystackListQuery & { readonly transactionId?: string }): Promise<ProviderPage<PaystackDispute>> {
    const parameters = new URLSearchParams(listQuery(query));
    if (query.transactionId) parameters.set('transaction', query.transactionId);
    const body = await this.client.send({ operation: 'list-disputes', method: 'GET', path: `/dispute?${parameters.toString()}` });
    return parseDisputePage(body, 'list-disputes');
  }
}

function listQuery(query: PaystackListQuery): string {
  return new URLSearchParams({
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    perPage: String(PAGE_SIZE),
    page: query.cursor ?? '1',
  }).toString();
}
