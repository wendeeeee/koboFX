import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBody, ApiExtension, ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public, RateLimit } from '../../../../common/decorators';
import { ErrorCode, InvariantViolationError, UnauthenticatedError } from '../../../../common/errors';
import { ApiErrors } from '../../../../openapi/api-errors.decorator';
import { PAYSTACK_SIGNATURE_SCHEME } from '../../../../openapi/openapi-document';
import { WebhookReceivedDocument } from '../../webhooks/psp-webhook.responses';
import { PaystackWebhookIngestionService } from './paystack-webhook-ingestion.service';

/** What the route reads of a Paystack event: the event name and ids. Anything else is ignored (and kept as evidence). */
export const PAYSTACK_WEBHOOK_BODY_SCHEMA = {
  type: 'object' as const,
  additionalProperties: true,
  description:
    'Paystack\'s event, verified over the RAW bytes (do not re-serialise). Only `event`, `data.id`, `data.status` and ' +
    '`data.reference` (`data.transaction` for disputes) are read; amounts never are — the event is a hint, Paystack\'s ' +
    'verify API is the fact.',
  properties: {
    event: { type: 'string' as const, maxLength: 64, example: 'charge.success' },
    data: {
      type: 'object' as const,
      properties: {
        id: { type: 'integer' as const, example: 2009945086 },
        status: { type: 'string' as const, example: 'success' },
        reference: { type: 'string' as const, maxLength: 128, example: '3c9a1f2e-7b4d-4e6a-9f80-1a2b3c4d5e6f' },
      },
    },
  },
};

/**
 * `POST /webhooks/paystack` (PAYSTACK_PLAN.md C4, F). Public — authenticated by `x-paystack-signature` over the raw
 * bytes, and by source address when `PAYSTACK_WEBHOOK_IP_ALLOWLIST` is set. Every delivery is stored before anything
 * else; processing is the worker's. Answers `200` (what Paystack retries on — a delta from the PSP route's `202`).
 * Registered only when `PAYSTACK_ENABLED=true`.
 */
@ApiTags('webhooks')
@Controller('webhooks')
export class PaystackWebhookController {
  constructor(private readonly ingestion: PaystackWebhookIngestionService) {}

  @Public()
  @RateLimit({
    rules: [{ name: 'paystack-webhook', subject: 'ip', limit: 1200, windowSeconds: 60 }],
    whenUnavailable: 'fail-open',
    replacesGlobalRule: true,
  })
  @Post('paystack')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Paystack event hint (machine-to-machine)',
    description:
      'Called by Paystack (the URL is set in the Paystack dashboard), not by API clients. Authenticated by ' +
      '`X-Paystack-Signature` (HMAC-SHA512 of the raw body with the secret key) and, when configured, by Paystack\'s ' +
      'published source addresses. The event is stored before anything else — even when refused (a security signal, ' +
      'answered with a generic 401) — then acknowledged `200`; processing is asynchronous.',
  })
  @ApiSecurity(PAYSTACK_SIGNATURE_SCHEME)
  @ApiExtension('x-machine-to-machine', true)
  @ApiBody({ schema: PAYSTACK_WEBHOOK_BODY_SCHEMA })
  @ApiOkResponse({ type: WebhookReceivedDocument })
  @ApiErrors(ErrorCode.UNAUTHENTICATED, ErrorCode.PAYLOAD_TOO_LARGE)
  async receive(@Req() request: Request): Promise<{ received: true }> {
    const rawBody: unknown = request.body;
    if (!Buffer.isBuffer(rawBody)) {
      throw new InvariantViolationError('The Paystack webhook route did not receive raw bytes; configureApp() must mount the raw parser.');
    }
    // `req.ip` honours X-Forwarded-For only through TRUST_PROXY_HOPS of our own proxies — never the raw header.
    const result = await this.ingestion.ingest(rawBody, request.headers, request.ip);
    if (!result.accepted) throw new UnauthenticatedError('Webhook verification failed.');
    return { received: true };
  }
}
