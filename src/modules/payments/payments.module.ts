import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { PaymentProvider } from './payment-provider.port';
import { ProviderCallRecorder } from './provider-call-recorder';
import { PspHttpClient } from './psp-http-client';
import { SimulatedPspAdapter } from './simulated-psp.adapter';

/**
 * The PSP port and its adapter (design §7.2, §14 `payments/`). The simulated PSP is
 * the only adapter; a real one would be bound here instead, behind the same port.
 */
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
