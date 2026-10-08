import { createHash } from 'node:crypto';
import { isLosslessNumber, parse } from 'lossless-json';
import { z } from 'zod';

/**
 * The only parts of a Paystack webhook we read (PAYSTACK_PLAN.md C4): which event, which transaction (id and OUR
 * reference) and the status Paystack claims — the last only for the dedupe key. Amounts (`amount`,
 * `requested_amount`) are NEVER read: the webhook is a hint, `verify` is the fact.
 *
 * Paystack sends no event id, so ours is `sha256(event | data.id | data.status | data.reference)`: the same delivery
 * retried dedupes; a later, different event about the same transaction (a dispute after a success) does not.
 */
const id = z.union([z.custom<{ value: string }>((value) => isLosslessNumber(value)), z.string()]);

const webhookSchema = z.object({
  event: z.string().min(1).max(64),
  data: z.object({
    id: id.optional(),
    status: z.string().max(64).nullable().optional(),
    reference: z.string().max(128).nullable().optional(),
    transaction: z
      .object({ id: id.optional(), reference: z.string().max(128).nullable().optional() })
      .nullable()
      .optional(),
  }),
});

export interface PaystackWebhookHint {
  readonly providerEventId: string;
  readonly eventType: string;
  /** Our reference (the funding flow id), from `data.reference` or, for disputes, `data.transaction.reference`. */
  readonly reference: string | null;
  /** Paystack's transaction id, when the event names one. */
  readonly transactionId: string | null;
}

function textOf(value: { value: string } | string | undefined): string | null {
  if (value === undefined) return null;
  return typeof value === 'string' ? value : value.value;
}

export function parsePaystackWebhookHint(rawBody: Buffer): PaystackWebhookHint | undefined {
  let json: unknown;
  try {
    json = parse(rawBody.toString('utf8'));
  } catch {
    return undefined;
  }
  const result = webhookSchema.safeParse(json);
  if (!result.success) return undefined;
  const { event, data } = result.data;
  const isDispute = event.startsWith('charge.dispute.');
  const transactionId = isDispute ? textOf(data.transaction?.id) : textOf(data.id);
  const reference = (isDispute ? data.transaction?.reference : data.reference) ?? null;
  const providerEventId = createHash('sha256')
    .update([event, textOf(data.id) ?? '', data.status ?? '', data.reference ?? ''].join('|'), 'utf8')
    .digest('hex');
  return { providerEventId, eventType: event, reference, transactionId };
}
