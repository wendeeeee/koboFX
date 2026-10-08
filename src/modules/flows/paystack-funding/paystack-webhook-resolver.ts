import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { PaystackEventFamily } from '../../payments/paystack/webhooks/paystack-event-family';
import { parsePaystackWebhookHint } from '../../payments/paystack/webhooks/paystack-webhook-payload';
import { PaystackFamilyResolver, PaystackWebhookRouter } from '../../payments/paystack/webhooks/paystack-webhook-router';
import { ResolvedWebhook } from '../../payments/webhooks/webhook-resolvers';
import { FlowRepository } from '../flow.repository';
import { FlowType } from '../flow.types';
import { FundingPaymentRepository } from '../funding/funding-payment.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


/** Funding's half of the Paystack webhook route: `charge.*` events only (the router decides the family first). */
@Injectable()
export class PaystackWebhookResolver implements PaystackFamilyResolver, OnModuleInit {
  readonly family = PaystackEventFamily.CHARGE as const;
  private readonly provider: string;

  constructor(
    private readonly router: PaystackWebhookRouter,
    private readonly flows: FlowRepository,
    private readonly payments: FundingPaymentRepository,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.provider = config.paystack.name;
  }

  onModuleInit(): void {
    this.router.registerFamily(this);
  }

  async resolve(rawPayload: Buffer, eventType: string): Promise<ResolvedWebhook> {
    const hint = parsePaystackWebhookHint(rawPayload);
    if (!hint) return { eventType, flowId: null };
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
