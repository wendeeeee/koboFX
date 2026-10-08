import { Money } from '../../common/money';
import {
  AuthorizePaymentRequest,
  ChargebackListQuery,
  ProviderChargebackRecord,
  PaymentListQuery,
  PaymentProvider,
  ProviderCallContext,
  ProviderPage,
  ProviderPayment,
  ProviderSettlementBatch,
  ProviderSettlementBatchSummary,
  ProviderSettlementLine,
  SettlementListQuery,
} from './payment-provider.port';
import { ProviderRequestRejectedError, ProviderResponseInvalidError } from './payment.errors';
import { PspHttpClient } from './psp-http-client';
import { parsePayment, parsePaymentList } from './psp-responses';
import {
  SettlementBatchHeader,
  parseChargebackPage,
  parsePaymentPage,
  parseSettlementBatchPage,
  parseSettlementSummaryPage,
  sameHeader,
} from './psp-settlement-responses';

const MAXIMUM_LINE_PAGES = 10_000;


export class SimulatedPspAdapter extends PaymentProvider {
  constructor(
    readonly name: string,
    private readonly client: PspHttpClient,
  ) {
    super();
  }

  async authorize(request: AuthorizePaymentRequest, context: ProviderCallContext): Promise<ProviderPayment> {
    const response = await this.client.send({
      operation: 'authorize',
      method: 'POST',
      path: '/v1/payments',
      idempotencyKey: request.idempotencyKey,
      flowId: context.flowId,
      body: {
        reference: request.reference,
        amount: request.amount.toMinorString(),
        currency: request.amount.currency,
        payment_method_token: request.paymentMethodToken,
        capture_method: 'manual',
      },
    });
    return parsePayment(response.body, 'authorize');
  }

  async capture(paymentId: string, amount: Money, idempotencyKey: string, context: ProviderCallContext): Promise<ProviderPayment> {
    const response = await this.client.send({
      operation: 'capture',
      method: 'POST',
      path: `/v1/payments/${encodeURIComponent(paymentId)}/capture`,
      idempotencyKey,
      flowId: context.flowId,
      body: { amount: amount.toMinorString() },
    });
    return parsePayment(response.body, 'capture');
  }

  async void(paymentId: string, idempotencyKey: string, context: ProviderCallContext): Promise<ProviderPayment> {
    const response = await this.client.send({
      operation: 'void',
      method: 'POST',
      path: `/v1/payments/${encodeURIComponent(paymentId)}/void`,
      idempotencyKey,
      flowId: context.flowId,
      body: {},
    });
    return parsePayment(response.body, 'void');
  }

  async getPayment(paymentId: string, context: ProviderCallContext): Promise<ProviderPayment> {
    const response = await this.client.send({
      operation: 'get-payment',
      method: 'GET',
      path: `/v1/payments/${encodeURIComponent(paymentId)}`,
      flowId: context.flowId,
    });
    return parsePayment(response.body, 'get-payment');
  }

  async findPaymentByReference(reference: string, context: ProviderCallContext): Promise<ProviderPayment | null> {
    try {
      const response = await this.client.send({
        operation: 'find-payment-by-reference',
        method: 'GET',
        path: `/v1/payments?reference=${encodeURIComponent(reference)}`,
        flowId: context.flowId,
      });
      const payments = parsePaymentList(response.body, 'find-payment-by-reference').filter(
        (payment) => payment.reference === reference,
      );
      return payments[0] ?? null;
    } catch (error) {
      if (error instanceof ProviderRequestRejectedError && error.responseStatus === 404) return null;
      throw error;
    }
  }

  async findPayment(paymentId: string, context: ProviderCallContext): Promise<ProviderPayment | null> {
    try {
      return await this.getPayment(paymentId, context);
    } catch (error) {
      if (error instanceof ProviderRequestRejectedError && error.responseStatus === 404) return null;
      throw error;
    }
  }

  async listPayments(query: PaymentListQuery): Promise<ProviderPage<ProviderPayment>> {
    const response = await this.client.send({
      operation: 'list-payments',
      method: 'GET',
      path: `/v1/payments?${rangeQuery('created', query.createdFrom, query.createdTo, query.cursor)}`,
    });
    return parsePaymentPage(response.body, 'list-payments');
  }

  async listChargebacks(query: ChargebackListQuery): Promise<ProviderPage<ProviderChargebackRecord>> {
    const response = await this.client.send({
      operation: 'list-chargebacks',
      method: 'GET',
      path: `/v1/chargebacks?${rangeQuery('created', query.createdFrom, query.createdTo, query.cursor)}`,
    });
    return parseChargebackPage(response.body, 'list-chargebacks');
  }

  async listSettlementBatches(query: SettlementListQuery): Promise<ProviderPage<ProviderSettlementBatchSummary>> {
    const response = await this.client.send({
      operation: 'list-settlements',
      method: 'GET',
      path: `/v1/settlements?${rangeQuery('settled', query.settledFrom, query.settledTo, query.cursor)}`,
      recordRawResponse: true,
    });
    return parseSettlementSummaryPage(response.body, 'list-settlements');
  }

  
  async getSettlementBatch(batchId: string): Promise<ProviderSettlementBatch> {
    const operation = 'get-settlement';
    let header: SettlementBatchHeader | undefined;
    const lines: ProviderSettlementLine[] = [];
    const providerCallIds: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAXIMUM_LINE_PAGES; page += 1) {
      const response = await this.client.send({
        operation,
        method: 'GET',
        path: `/v1/settlements/${encodeURIComponent(batchId)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        recordRawResponse: true,
      });
      if (response.providerCallId !== undefined) providerCallIds.push(response.providerCallId);
      const parsed = parseSettlementBatchPage(response.body, operation);
      if (parsed.header.batchId !== batchId) {
        throw new ProviderResponseInvalidError(`The PSP answered settlement ${batchId} with ${parsed.header.batchId}.`, operation);
      }
      if (header && !sameHeader(header, parsed.header)) {
        throw new ProviderResponseInvalidError(`Settlement ${batchId} changed while its pages were read.`, operation);
      }
      header ??= parsed.header;
      lines.push(...parsed.lines);
      cursor = parsed.nextCursor;
      if (cursor === null) return { ...header, lines, providerCallIds };
    }
    throw new ProviderResponseInvalidError(`Settlement ${batchId} has more than ${MAXIMUM_LINE_PAGES} line pages.`, operation);
  }
}

function rangeQuery(field: string, from: Date, to: Date, cursor: string | undefined): string {
  const parameters = new URLSearchParams({ [`${field}_from`]: from.toISOString(), [`${field}_to`]: to.toISOString() });
  if (cursor) parameters.set('cursor', cursor);
  return parameters.toString();
}
