import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { ReconciliationModule } from '../../reconciliation/reconciliation.module';
import { PaystackReconciliationComposer } from '../../reconciliation/paystack/paystack-reconciliation.composer';
import { PaymentsModule } from '../payments.module';
import { ProviderCallRecorder } from '../provider-call-recorder';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { PaystackGateway } from './paystack-gateway.port';
import { PaystackHttpClient } from './paystack-http-client';
import { PaystackAdapter } from './paystack.adapter';
import { PaystackWebhookController } from './webhooks/paystack-webhook.controller';
import { PaystackWebhookIngestionService } from './webhooks/paystack-webhook-ingestion.service';
import { PaystackWebhookRouter } from './webhooks/paystack-webhook-router';


/**
 * The Paystack boundary shared by funding and transfers: one webhook ingress, the funding gateway and — W4 — THE
 * Paystack reconciliation (`PaystackReconciliationComposer`), present wherever this module is (a Paystack key is
 * configured); funding and withdrawals register their components with it.
 */
@Module({
  imports: [PaymentsModule, WebhooksModule, ReconciliationModule],
  controllers: [PaystackWebhookController],
  providers: [
    PaystackWebhookIngestionService,
    PaystackWebhookRouter,
    PaystackReconciliationComposer,
    {
      provide: PaystackGateway,
      inject: [APP_CONFIG, ProviderCallRecorder],
      useFactory: (config: AppConfig, recorder: ProviderCallRecorder): PaystackGateway => {
        const paystack = config.paystack;
        const client = new PaystackHttpClient(
          {
            provider: paystack.name,
            baseUrl: paystack.baseUrl,
            secretKey: paystack.secretKey,
            timeoutMilliseconds: paystack.requestTimeoutMilliseconds,
            initializeTimeoutMilliseconds: paystack.initializeTimeoutMilliseconds,
            readRetries: paystack.readRetries,
          },
          recorder,
        );
        return new PaystackAdapter(paystack.name, client);
      },
    },
  ],
  exports: [PaystackGateway, PaystackWebhookRouter, PaystackReconciliationComposer],
})
export class PaystackModule {}
