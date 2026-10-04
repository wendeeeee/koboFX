import { Injectable } from '@nestjs/common';
import { InvariantViolationError } from '../../../common/errors';


export interface ResolvedWebhook {
  readonly eventType: string;
  readonly flowId: string | null;
  /** Set when the event's identifiers point at different intents: recorded, routed nowhere (WITHDRAWAL_PLAN.md §I.1). */
  readonly conflict?: string;
}


export interface WebhookResolver {
  readonly provider: string;
  resolve(rawPayload: Buffer): Promise<ResolvedWebhook | undefined>;
}

@Injectable()
export class WebhookResolverRegistry {
  private readonly resolvers = new Map<string, WebhookResolver>();

  register(resolver: WebhookResolver): void {
    if (this.resolvers.has(resolver.provider)) {
      throw new InvariantViolationError(`Two webhook resolvers registered for ${resolver.provider}.`);
    }
    this.resolvers.set(resolver.provider, resolver);
  }

  find(provider: string): WebhookResolver | undefined {
    return this.resolvers.get(provider);
  }
}
