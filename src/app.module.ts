import { DynamicModule, Module, RequestMethod } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { MoneyModule } from './common/money/money.module';
import { RequestWithCorrelation } from './common/context';
import { APP_CONFIG, ConfigModule } from './config/config.module';
import { AppConfig } from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { CurrenciesModule } from './modules/currencies/currencies.module';

/** Log hygiene (design §9.1): secrets and OTPs never reach the log. */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-webhook-signature"]',
  '*.password',
  '*.otp',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.cardNumber',
  '*.cvv',
];

@Module({})
export class AppModule {
  static forRoot(env: Record<string, string | undefined> = process.env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(env),
        LoggerModule.forRootAsync({
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig) => ({
            // Express 5 / path-to-regexp v8 wildcard syntax.
            forRoutes: [{ path: '{*path}', method: RequestMethod.ALL }],
            pinoHttp: {
              level: config.logLevel,
              // The correlation middleware runs first and has already chosen the id.
              genReqId: (req) => (req as RequestWithCorrelation).correlationId ?? 'unknown',
              customProps: (req) => ({ correlationId: (req as RequestWithCorrelation).correlationId }),
              redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
            },
          }),
        }),
        DatabaseModule,
        MoneyModule,
        CurrenciesModule,
      ],
    };
  }
}
