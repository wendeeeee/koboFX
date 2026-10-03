import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiAcceptedResponse, ApiBody, ApiExtension, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public, RateLimit } from '../../../common/decorators';
import { ErrorCode, InvariantViolationError, UnauthenticatedError } from '../../../common/errors';
import { ApiErrors } from '../../../openapi/api-errors.decorator';
import { PSP_SIGNATURE_SCHEME } from '../../../openapi/openapi-document';
import { PSP_WEBHOOK_BODY_SCHEMA, WebhookReceivedDocument } from './psp-webhook.responses';
import { WebhookIngestionService } from './webhook-ingestion.service';

@ApiTags('webhooks')
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
  @ApiOperation({
    summary: 'PSP event hint (machine-to-machine)',
    description:
      'Called by the payment service provider, not by API clients. Authenticated by `X-Psp-Signature` over the raw ' +
      'body (no bearer token). The event is stored before anything else — even when the signature is invalid (a ' +
      'security signal, answered with a generic 401) — then acknowledged `202`; processing is asynchronous.',
  })
  @ApiSecurity(PSP_SIGNATURE_SCHEME)
  @ApiExtension('x-machine-to-machine', true)
  @ApiBody({ schema: PSP_WEBHOOK_BODY_SCHEMA })
  @ApiAcceptedResponse({ type: WebhookReceivedDocument })
  @ApiErrors(ErrorCode.UNAUTHENTICATED, ErrorCode.PAYLOAD_TOO_LARGE)
  async receive(@Req() request: Request): Promise<{ received: true }> {
    const rawBody: unknown = request.body;
    if (!Buffer.isBuffer(rawBody)) {
      throw new InvariantViolationError('The webhook route did not receive raw bytes; configureApp() must mount the raw parser.');
    }
    const result = await this.ingestion.ingest(rawBody, request.headers);
    if (!result.signatureValid) throw new UnauthenticatedError('Webhook signature verification failed.');
    return { received: true };
  }
}
