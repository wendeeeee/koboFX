import { Module } from '@nestjs/common';
import { FlowsModule } from '../../flows/flows.module';
import { PaymentsModule } from '../payments.module';
import { PspWebhookController } from './psp-webhook.controller';
import { WebhookIngestionService } from './webhook-ingestion.service';
import { WebhookMetrics } from './webhook-metrics';
import { WebhookProcessor } from './webhook-processor';

/** PSP webhooks (design §7.3): ingestion in the API, processing in the worker. */
@Module({
  imports: [PaymentsModule, FlowsModule],
  controllers: [PspWebhookController],
  providers: [WebhookIngestionService, WebhookMetrics, WebhookProcessor],
  exports: [WebhookIngestionService, WebhookMetrics, WebhookProcessor],
})
export class WebhooksModule {}
