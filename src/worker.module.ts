import { DynamicModule, Module } from '@nestjs/common';
import { loggerModule } from './app.module';
import { ClockModule } from './common/clock';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { RedisModule } from './redis/redis.module';

/**
 * The worker process (design §3, §14): no HTTP. Phase 4 runs the outbox dispatcher;
 * later phases add the FX poller, the flow resumer, the reservation sweeper and
 * reconciliation here.
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
        OutboxModule,
        NotificationsModule,
      ],
    };
  }
}
