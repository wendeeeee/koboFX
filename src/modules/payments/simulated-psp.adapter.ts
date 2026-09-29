import { Money } from '../../common/money';
import {
  AuthorizePaymentRequest,
  PaymentProvider,
  ProviderCallContext,
  ProviderPayment,
} from './payment-provider.port';
import { ProviderRequestRejectedError } from './payment.errors';
import { PspHttpClient } from './psp-http-client';
import { parsePayment, parsePaymentList } from './psp-responses';

/**
 * The adapter for the simulated PSP (`src/mock-psp/`) — a real HTTP API, so the
 * adapter really sees timeouts, 5xx, `200`s carrying errors and malformed bodies
 * (design §15 item 5: "funding is simulated behind a real port"). A real provider
 * would be another adapter behind the same port.
 */
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
}
