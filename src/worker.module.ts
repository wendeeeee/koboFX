import { DynamicModule, Module } from '@nestjs/common';
import { loggerModule } from './app.module';
import { ClockModule } from './common/clock';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { AuditModule } from './modules/audit/audit.module';
import { CurrenciesModule } from './modules/currencies/currencies.module';
import { FlowsModule } from './modules/flows/flows.module';
import { FxModule } from './modules/fx/fx.module';
import { MoneyModule } from './common/money/money.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { ReservationsModule } from './modules/reservations/reservations.module';
import { WebhooksModule } from './modules/payments/webhooks/webhooks.module';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module';
import { RedisModule } from './redis/redis.module';
import { AdminModule } from './modules/admin/admin.module';
import { PaystackFundingModule, isPaystackEnabled } from './modules/flows/paystack-funding/paystack-funding.module';

/**
 * The worker process: runs the outbox dispatcher, the flow
 * resumer, the webhook processor, the reservation sweeper, the FX poller and the
 * reconciliation schedulerand the control monitor (expiry, break-glass review).
 */
@Module({})
export class WorkerModule {
  static forRoot(env: Record<string, string | undefined> = process.env): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        ConfigModule.forRoot(env),
        loggerModule(),
        DatabaseModule,
        ClockModule,
        RedisModule,
        CurrenciesModule,
        LedgerModule,
        AuditModule,
        ReservationsModule,
        OutboxModule,
        NotificationsModule,
        FlowsModule,
        WebhooksModule,
        MoneyModule,
        FxModule,
        ReconciliationModule,
        AdminModule,
        ...(isPaystackEnabled(env) ? [PaystackFundingModule] : []),
      ],
    };
  }
}
