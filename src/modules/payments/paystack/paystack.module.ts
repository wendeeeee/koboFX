import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { PaymentsModule } from '../payments.module';
import { ProviderCallRecorder } from '../provider-call-recorder';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { PaystackGateway } from './paystack-gateway.port';
import { PaystackHttpClient } from './paystack-http-client';
import { PaystackAdapter } from './paystack.adapter';
import { PaystackWebhookController } from './webhooks/paystack-webhook.controller';
import { PaystackWebhookIngestionService } from './webhooks/paystack-webhook-ingestion.service';


@Module({
  imports: [PaymentsModule, WebhooksModule],
  controllers: [PaystackWebhookController],
  providers: [
    PaystackWebhookIngestionService,
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
  exports: [PaystackGateway],
})
export class PaystackModule {}
