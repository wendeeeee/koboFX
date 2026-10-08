import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../../../config/config.module';
import { AppConfig } from '../../../../config/configuration';
import { ProviderCallRecorder } from '../../provider-call-recorder';
import { PaymentsModule } from '../../payments.module';
import { PaystackModule } from '../paystack.module';
import { PaystackTransferWebhookResolver } from './paystack-transfer-webhook-resolver';
import { PaystackTransfersHttpClient } from './paystack-transfers-http-client';
import { PaystackTransfersAdapter } from './paystack-transfers.adapter';
import { PaystackTransfersGateway } from './paystack-transfers.port';

/**
 * The Paystack Transfers boundary (WITHDRAWAL_PLAN.md §H, §I.1; W2): the gateway (same account, key and transport as
 * funding) and the TRANSFER-family webhook resolver. Wiring into the API and worker, behind the admission switch and
 * the recovery rules of §K, is W3's.
 */
@Module({
  imports: [PaymentsModule, PaystackModule],
  providers: [
    PaystackTransferWebhookResolver,
    {
      provide: PaystackTransfersGateway,
      inject: [APP_CONFIG, ProviderCallRecorder],
      useFactory: (config: AppConfig, recorder: ProviderCallRecorder): PaystackTransfersGateway => {
        const paystack = config.paystack;
        return new PaystackTransfersAdapter(
          new PaystackTransfersHttpClient(
            {
              provider: paystack.name,
              baseUrl: paystack.baseUrl,
              secretKey: paystack.secretKey,
              timeoutMilliseconds: paystack.requestTimeoutMilliseconds,
              writeTimeoutMilliseconds: paystack.initializeTimeoutMilliseconds,
              readRetries: paystack.readRetries,
            },
            recorder,
          ),
        );
      },
    },
  ],
  exports: [PaystackTransfersGateway, PaystackTransferWebhookResolver],
})
export class PaystackTransfersModule {}
