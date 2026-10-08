import { Module } from '@nestjs/common';
import { FlowsModule } from '../../flows/flows.module';
import { ProtectionModule } from '../../protection/protection.module';
import { StoredWebhookPayloadReader } from './stored-webhook-payload';
import { PaymentsModule } from '../payments.module';
import { PspWebhookController } from './psp-webhook.controller';
import { WebhookIngestionService } from './webhook-ingestion.service';
import { WebhookMetrics } from './webhook-metrics';
import { WebhookProcessor } from './webhook-processor';
import { WebhookResolverRegistry } from './webhook-resolvers';

@Module({
  imports: [PaymentsModule, FlowsModule, ProtectionModule],
  controllers: [PspWebhookController],
  providers: [WebhookIngestionService, WebhookMetrics, WebhookProcessor, WebhookResolverRegistry, StoredWebhookPayloadReader],
  exports: [WebhookIngestionService, WebhookMetrics, WebhookProcessor, WebhookResolverRegistry, StoredWebhookPayloadReader, ProtectionModule],
})
export class WebhooksModule {}
