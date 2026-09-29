import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public, RateLimit } from '../../../common/decorators';
import { InvariantViolationError, UnauthenticatedError } from '../../../common/errors';
import { WebhookIngestionService } from './webhook-ingestion.service';

/**
 * `POST /webhooks/psp` (design §12): the only `@Public()` route that is not an auth
 * endpoint — authenticated by its HMAC signature instead of a token. Acknowledges fast
 * (`202`) once the raw event is durably stored; processing is asynchronous (worker).
 *
 * Rate limit: its own per-IP rule replaces the global 100/min, which would throttle a
 * real PSP; it still bounds how many (stored) forgeries one address can send.
 */
@Controller('webhooks')
export class PspWebhookController {
  constructor(private readonly ingestion: WebhookIngestionService) {}

  @Public()
  @RateLimit({
    rules: [{ name: 'psp-webhook', subject: 'ip', limit: 1200, windowSeconds: 60 }],
    whenUnavailable: 'fail-open',
    replacesGlobalRule: true,
  })
  @Post('psp')
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(@Req() request: Request): Promise<{ received: true }> {
    const rawBody: unknown = request.body;
    if (!Buffer.isBuffer(rawBody)) {
      throw new InvariantViolationError('The webhook route did not receive raw bytes; configureApp() must mount the raw parser.');
    }
    const result = await this.ingestion.ingest(rawBody, request.headers);
    // Stored either way (a security signal); the caller learns only that it was refused.
    if (!result.signatureValid) throw new UnauthenticatedError('Webhook signature verification failed.');
    return { received: true };
  }
}
