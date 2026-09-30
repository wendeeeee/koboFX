import { DynamicModule, Module, RequestMethod } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { ClockModule } from './common/clock';
import { JwtAuthGuard, RateLimitGuard, RolesGuard, UserRateLimitGuard, VerifiedUserGuard } from './common/guards';
import { IdempotencyInterceptor } from './common/interceptors/idempotency/idempotency.interceptor';
import { IdempotencyKeyStore } from './common/interceptors/idempotency/idempotency-key.store';
import { IdempotencyMetrics } from './common/interceptors/idempotency/idempotency-metrics';
import { MoneyModule } from './common/money/money.module';
import { RequestWithCorrelation } from './common/context';
import { APP_CONFIG, ConfigModule } from './config/config.module';
import { AppConfig } from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { CurrenciesModule } from './modules/currencies/currencies.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ReservationsModule } from './modules/reservations/reservations.module';
import { FlowsModule } from './modules/flows/flows.module';
import { FxModule } from './modules/fx/fx.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { WebhooksModule } from './modules/payments/webhooks/webhooks.module';
import { TradingModule } from './modules/trading/trading.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module';
import { AdminModule } from './modules/admin/admin.module';
import { RedisModule } from './redis/redis.module';

/** Log hygiene (design §9.1): secrets and OTPs never reach the log. */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-webhook-signature"]',
  'req.headers["x-psp-signature"]',
  '*.paymentMethodToken',
  '*.payment_method_token',
  '*.secretKey',
  '*.password',
  '*.otp',
  '*.oneTimePassword',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.cardNumber',
  '*.cvv',
];

export interface AppModuleOptions {
  /** Where logs go (default stdout). Tests capture them to prove log hygiene. */
  readonly logStream?: DestinationStream;
}

/** Log hygiene (design §9.1). Shared with the worker. */
export function loggerModule(options: AppModuleOptions = {}): DynamicModule {
  return LoggerModule.forRootAsync({
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig) => {
      const pinoHttpOptions = {
        level: config.logLevel,
        // The correlation middleware runs first and has already chosen the id.
        genReqId: (req: unknown) => (req as RequestWithCorrelation).correlationId ?? 'unknown',
        customProps: (req: unknown) => ({ correlationId: (req as RequestWithCorrelation).correlationId }),
        redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      };
      return {
        // Express 5 / path-to-regexp v8 wildcard syntax.
        forRoutes: [{ path: '{*path}', method: RequestMethod.ALL }],
        pinoHttp: options.logStream ? [pinoHttpOptions, options.logStream] : pinoHttpOptions,
      };
    },
  });
}

@Module({})
export class AppModule {
  static forRoot(env: Record<string, string | undefined> = process.env, options: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(env),
        loggerModule(options),
        DatabaseModule,
        MoneyModule,
        CurrenciesModule,
        ClockModule,
        RedisModule,
        LedgerModule,
        ReservationsModule,
        AuthModule,
        NotificationsModule,
        PaymentsModule,
        FlowsModule,
        WalletsModule,
        WebhooksModule,
        FxModule,
        TradingModule,
        TransactionsModule,
        // No HTTP surface of its own; its loop runs only in the worker. The admin module reads it.
        ReconciliationModule,
        // Controls (Phase 10): `/admin/*`, approvals and four-eyes, positions, recertification.
        AdminModule,
        HealthModule,
      ],
      // Order matters: throttle first (before any token work), then authenticate,
      // then authorise by role, then require a verified, non-suspended user.
      providers: [
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: VerifiedUserGuard },
        // Per-user limits need the authenticated user, so they come last.
        { provide: APP_GUARD, useClass: UserRateLimitGuard },
        // After the guards: the barrier is scoped by the authenticated user (design §6.5).
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
        IdempotencyKeyStore,
        IdempotencyMetrics,
      ],
    };
  }
}
