import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { RoundingPolicy } from './rounding-policy';

/** Provides the configured RoundingPolicy (strategies per purpose come from config). */
@Global()
@Module({
  providers: [
    {
      provide: RoundingPolicy,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new RoundingPolicy(config.rounding),
    },
  ],
  exports: [RoundingPolicy],
})
export class MoneyModule {}
