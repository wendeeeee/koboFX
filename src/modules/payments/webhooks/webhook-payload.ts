import { z } from 'zod';


const webhookSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.string().min(1).max(64),
  data: z.object({
    object: z.object({
      id: z.string().min(1).max(128),
      reference: z.string().min(1).max(128).optional(),
    }),
  }),
});

export interface WebhookHint {
  readonly providerEventId: string;
  readonly eventType: string;
  readonly paymentId: string;
  readonly reference: string | null;
}

export function extractProviderEventId(rawBody: Buffer): string | undefined {
  return parseWebhookHint(rawBody)?.providerEventId;
}

export function parseWebhookHint(rawBody: Buffer): WebhookHint | undefined {
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return undefined;
  }
  const result = webhookSchema.safeParse(json);
  if (!result.success) return undefined;
  return {
    providerEventId: result.data.id,
    eventType: result.data.type,
    paymentId: result.data.data.object.id,
    reference: result.data.data.object.reference ?? null,
  };
}
