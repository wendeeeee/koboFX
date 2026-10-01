import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { parsePaystackWebhookHint } from '../../payments/paystack/webhooks/paystack-webhook-payload';
import { ResolvedWebhook, WebhookResolver, WebhookResolverRegistry } from '../../payments/webhooks/webhook-resolvers';
import { FlowRepository } from '../flow.repository';
import { FlowType } from '../flow.types';
import { FundingPaymentRepository } from '../funding/funding-payment.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which Paystack funding a stored webhook is about: by Paystack's transaction id once we recorded it, else by OUR
 * reference (the flow id) — but only a reference naming a `PAYSTACK_FUNDING` flow. Anything else is UNMATCHED (kept
 * for reconciliation). Nothing else in the payload is read.
 */
@Injectable()
export class PaystackWebhookResolver implements WebhookResolver, OnModuleInit {
  readonly provider: string;

  constructor(
    private readonly registry: WebhookResolverRegistry,
    private readonly flows: FlowRepository,
    private readonly payments: FundingPaymentRepository,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.provider = config.paystack.name;
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async resolve(rawPayload: Buffer): Promise<ResolvedWebhook | undefined> {
    const hint = parsePaystackWebhookHint(rawPayload);
    if (!hint) return undefined;
    if (hint.transactionId) {
      const byTransaction = await this.payments.findFlowIdByProviderPayment(this.provider, hint.transactionId);
      if (byTransaction) return { eventType: hint.eventType, flowId: byTransaction };
    }
    if (hint.reference && UUID.test(hint.reference)) {
      const flow = await this.flows.findById(hint.reference);
      if (flow?.flowType === FlowType.PAYSTACK_FUNDING) return { eventType: hint.eventType, flowId: flow.id };
    }
    return { eventType: hint.eventType, flowId: null };
  }
}
