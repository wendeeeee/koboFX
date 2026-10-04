import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { InvariantViolationError } from '../../../../common/errors';
import { APP_CONFIG } from '../../../../config/config.module';
import { AppConfig } from '../../../../config/configuration';
import { ResolvedWebhook, WebhookResolver, WebhookResolverRegistry } from '../../webhooks/webhook-resolvers';
import { eventTypeOf, familyOfEvent, PaystackEventFamily } from './paystack-event-family';

/** Resolves events of ONE family (funding: CHARGE; withdrawals: TRANSFER). */
export interface PaystackFamilyResolver {
  readonly family: PaystackEventFamily.CHARGE | PaystackEventFamily.TRANSFER;
  resolve(rawPayload: Buffer, eventType: string): Promise<ResolvedWebhook>;
}

/**
 * The one Paystack registration with the webhook processor (WITHDRAWAL_PLAN.md §I.1): it reads the event family from
 * the event name FIRST, then hands the payload to that family's resolver only. A family nobody registered (or an
 * unknown family) is unmatched — preserved, never guessed. Funding and withdrawals register here; neither registers
 * with the processor directly, so the two can never both claim an event.
 */
@Injectable()
export class PaystackWebhookRouter implements WebhookResolver, OnModuleInit {
  readonly provider: string;
  private readonly families = new Map<PaystackEventFamily, PaystackFamilyResolver>();

  constructor(
    private readonly registry: WebhookResolverRegistry,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.provider = config.paystack.name;
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  registerFamily(resolver: PaystackFamilyResolver): void {
    if (this.families.has(resolver.family)) {
      throw new InvariantViolationError(`Two Paystack resolvers registered for the ${resolver.family} family.`);
    }
    this.families.set(resolver.family, resolver);
  }

  async resolve(rawPayload: Buffer): Promise<ResolvedWebhook | undefined> {
    const eventType = eventTypeOf(rawPayload);
    if (!eventType) return undefined;
    const family = familyOfEvent(eventType);
    const resolver = family === PaystackEventFamily.UNKNOWN ? undefined : this.families.get(family);
    if (!resolver) return { eventType, flowId: null };
    return resolver.resolve(rawPayload, eventType);
  }
}
