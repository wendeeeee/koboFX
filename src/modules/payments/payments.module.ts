import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { PaymentProvider } from './payment-provider.port';
import { ProviderCallRecorder } from './provider-call-recorder';
import { PspHttpClient } from './psp-http-client';
import { SimulatedPspAdapter } from './simulated-psp.adapter';


@Module({
  providers: [
    ProviderCallRecorder,
    {
      provide: PaymentProvider,
      inject: [APP_CONFIG, ProviderCallRecorder],
      useFactory: (config: AppConfig, recorder: ProviderCallRecorder): PaymentProvider => {
        const provider = config.paymentProvider;
        const client = new PspHttpClient(
          {
            provider: provider.name,
            baseUrl: provider.baseUrl,
            secretKey: provider.secretKey,
            timeoutMilliseconds: provider.requestTimeoutMilliseconds,
            readRetries: provider.readRetries,
          },
          recorder,
        );
        return new SimulatedPspAdapter(provider.name, client);
      },
    },
  ],
  exports: [PaymentProvider, ProviderCallRecorder],
})
export class PaymentsModule {}
