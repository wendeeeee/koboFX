import type { IncomingHttpHeaders } from 'node:http';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { ProviderCallDirection, ProviderCallRecorder, unparsedBody } from '../provider-call-recorder';
import { parseWebhookHint } from './webhook-payload';
import { WEBHOOK_SIGNATURE_HEADER, verifyWebhookSignature } from './webhook-signature';
import { WebhookMetrics } from './webhook-metrics';

/** Headers kept as evidence. Never `Authorization` or cookies; the signature is not a secret. */
const STORED_HEADERS = ['content-type', 'content-length', 'user-agent', WEBHOOK_SIGNATURE_HEADER];

export interface IngestionResult {
  readonly signatureValid: boolean;
  readonly webhookEventId: string;
  readonly duplicate: boolean;
}

/**
 * Receives a PSP webhook (design §7.3): verify the HMAC over the RAW bytes, persist the
 * raw payload verbatim with `signature_valid`, dedupe on the provider's event id — among
 * VALID events only, so a forged event can never suppress the genuine one — and record
 * the delivery in `provider_calls`, all in one transaction. Nothing here acts on the
 * content: the worker's processor does, by asking the PSP's API.
 */
@Injectable()
export class WebhookIngestionService {
  private readonly logger = new Logger(WebhookIngestionService.name);

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly recorder: ProviderCallRecorder,
    private readonly metrics: WebhookMetrics,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async ingest(rawBody: Buffer, headers: IncomingHttpHeaders, now: Date = new Date()): Promise<IngestionResult> {
    const provider = this.config.paymentProvider;
    const signatureHeader = headers[WEBHOOK_SIGNATURE_HEADER];
    const verdict = verifyWebhookSignature(
      typeof signatureHeader === 'string' ? signatureHeader : undefined,
      rawBody,
      provider.webhookSecrets,
      Math.floor(now.getTime() / 1000),
      provider.webhookToleranceSeconds,
    );
    const hint = parseWebhookHint(rawBody);
    const storedHeaders = Object.fromEntries(
      STORED_HEADERS.filter((name) => typeof headers[name] === 'string').map((name) => [name, headers[name]]),
    );
    const outcome = !verdict.valid ? 'INVALID_SIGNATURE' : hint ? null : 'MALFORMED';

    const result = await this.unitOfWork.run(async (manager) => {
      const inserted = (await manager.query(
        `INSERT INTO webhook_events (provider, provider_event_id, raw_payload, headers, signature_valid, outcome, processed_at)
         VALUES ($1, $2, $3, $4, $5, $6::webhook_event_outcome, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END)
         ON CONFLICT (provider, provider_event_id) WHERE signature_valid AND provider_event_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [provider.name, hint?.providerEventId ?? null, rawBody, JSON.stringify(storedHeaders), verdict.valid, outcome],
      )) as { id: string }[];
      let webhookEventId = inserted[0]?.id;
      if (!webhookEventId) {
        const [existing] = (await manager.query(
          `SELECT id FROM webhook_events WHERE provider = $1 AND provider_event_id = $2 AND signature_valid`,
          [provider.name, hint?.providerEventId],
        )) as { id: string }[];
        webhookEventId = existing.id;
      }
      await this.recorder.record({
        provider: provider.name,
        operation: hint ? `webhook:${hint.eventType}` : 'webhook',
        direction: ProviderCallDirection.INBOUND,
        webhookEventId,
        requestMethod: 'POST',
        requestPath: '/webhooks/psp',
        requestBody: hint ? safeJson(rawBody) : unparsedBody(rawBody.toString('utf8')),
        responseStatus: verdict.valid ? 202 : 401,
        error: verdict.valid ? (inserted.length === 0 ? 'duplicate delivery' : undefined) : `signature ${verdict.reason}`,
      });
      return { webhookEventId, duplicate: inserted.length === 0 };
    });

    if (!verdict.valid) {
      this.metrics.recordInvalidSignature();
      this.logger.warn({ webhookEventId: result.webhookEventId, reason: verdict.reason }, 'Webhook with an invalid signature stored');
    }
    return { signatureValid: verdict.valid, ...result };
  }
}

function safeJson(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    return unparsedBody(rawBody.toString('utf8'));
  }
}
