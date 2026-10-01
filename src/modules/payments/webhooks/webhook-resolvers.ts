import { Injectable } from '@nestjs/common';
import { InvariantViolationError } from '../../../common/errors';

/** What a stored webhook means to the processor: the event and the flow it is about (null = we know no such payment). */
export interface ResolvedWebhook {
  readonly eventType: string;
  readonly flowId: string | null;
}

/**
 * Reads one provider's stored webhook payloads (PAYSTACK_PLAN.md E, B6). The configured simulated PSP is handled by
 * the processor itself, exactly as before; any other provider registers a resolver here. `undefined` = malformed.
 */
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
