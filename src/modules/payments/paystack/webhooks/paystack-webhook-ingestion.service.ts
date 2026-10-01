import type { IncomingHttpHeaders } from 'node:http';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../../../config/config.module';
import { AppConfig } from '../../../../config/configuration';
import { UnitOfWork } from '../../../../database/transaction/unit-of-work';
import { ProviderCallDirection, ProviderCallRecorder } from '../../provider-call-recorder';
import { WebhookMetrics } from '../../webhooks/webhook-metrics';
import { parsePaystackWebhookHint } from './paystack-webhook-payload';
import { PAYSTACK_SIGNATURE_HEADER, verifyPaystackSignature } from './paystack-webhook-signature';

/** Headers kept as evidence. Never `Authorization` or cookies; the signature is not a secret. */
const STORED_HEADERS = ['content-type', 'content-length', 'user-agent', PAYSTACK_SIGNATURE_HEADER];

export interface PaystackIngestionResult {
  /** Signature valid AND (when an allowlist is configured) from an allowed address. */
  readonly accepted: boolean;
  readonly webhookEventId: string;
  readonly duplicate: boolean;
}

/** `::ffff:52.31.139.75` (an IPv4 client on a dual-stack socket) is `52.31.139.75`. */
export function normalizeAddress(address: string | undefined): string {
  if (!address) return '';
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

/**
 * Receives a Paystack webhook (PAYSTACK_PLAN.md C4; design §7.3): verify the HMAC-SHA512 over the RAW bytes, check the
 * source against `PAYSTACK_WEBHOOK_IP_ALLOWLIST` when one is set (fail-closed), and store EVERY delivery verbatim with
 * `signature_valid` — accepted, forged or from a refused address — plus a `provider_calls` row, in one transaction.
 *
 * Only an accepted delivery carries a `provider_event_id`, so a forgery can never occupy the dedupe slot of the
 * genuine event. Nothing here acts on the content; the worker's processor does, by asking Paystack's verify API.
 */
@Injectable()
export class PaystackWebhookIngestionService {
  private readonly logger = new Logger(PaystackWebhookIngestionService.name);

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly recorder: ProviderCallRecorder,
    private readonly metrics: WebhookMetrics,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async ingest(rawBody: Buffer, headers: IncomingHttpHeaders, sourceAddress: string | undefined): Promise<PaystackIngestionResult> {
    const paystack = this.config.paystack;
    const signatureHeader = headers[PAYSTACK_SIGNATURE_HEADER];
    const verdict = verifyPaystackSignature(typeof signatureHeader === 'string' ? signatureHeader : undefined, rawBody, paystack.secretKey);
    const source = normalizeAddress(sourceAddress);
    const sourceAllowed = paystack.webhookIpAllowlist === null || paystack.webhookIpAllowlist.includes(source);
    const hint = parsePaystackWebhookHint(rawBody);
    const accepted = verdict.valid && sourceAllowed;
    const outcome = !sourceAllowed ? 'SOURCE_NOT_ALLOWED' : !verdict.valid ? 'INVALID_SIGNATURE' : hint ? null : 'MALFORMED';
    const providerEventId = accepted ? (hint?.providerEventId ?? null) : null;
    const storedHeaders = Object.fromEntries(
      STORED_HEADERS.filter((name) => typeof headers[name] === 'string').map((name) => [name, headers[name]]),
    );
    const refusal = !sourceAllowed ? `source ${source || 'unknown'} not allowed` : !verdict.valid ? `signature ${verdict.reason}` : undefined;

    const result = await this.unitOfWork.run(async (manager) => {
      const inserted = (await manager.query(
        `INSERT INTO webhook_events (provider, provider_event_id, raw_payload, headers, signature_valid, outcome, processed_at)
         VALUES ($1, $2, $3, $4, $5, $6::webhook_event_outcome, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END)
         ON CONFLICT (provider, provider_event_id) WHERE signature_valid AND provider_event_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [paystack.name, providerEventId, rawBody, JSON.stringify(storedHeaders), verdict.valid, outcome],
      )) as { id: string }[];
      let webhookEventId = inserted[0]?.id;
      if (!webhookEventId) {
        const [existing] = (await manager.query(
          `SELECT id FROM webhook_events WHERE provider = $1 AND provider_event_id = $2 AND signature_valid`,
          [paystack.name, providerEventId],
        )) as { id: string }[];
        webhookEventId = existing.id;
      }
      await this.recorder.record({
        provider: paystack.name,
        operation: hint ? `webhook:${hint.eventType}` : 'webhook',
        direction: ProviderCallDirection.INBOUND,
        webhookEventId,
        requestMethod: 'POST',
        requestPath: '/webhooks/paystack',
        // Ids only: the full payload (customer data included) is the stored raw evidence, not copied here.
        requestBody: hint ? { event: hint.eventType, reference: hint.reference, transactionId: hint.transactionId } : { unparsed: true },
        responseStatus: accepted ? 200 : 401,
        error: refusal ?? (inserted.length === 0 ? 'duplicate delivery' : undefined),
      });
      return { webhookEventId, duplicate: inserted.length === 0 };
    });
    if (!verdict.valid) this.metrics.recordInvalidSignature();
    if (!accepted) {
      this.logger.warn({ webhookEventId: result.webhookEventId, reason: refusal }, 'Paystack webhook refused and stored');
    }
    return { accepted, ...result };
  }
}
