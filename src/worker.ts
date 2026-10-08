import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { ConfigValidationError } from './config/configuration';
import { FlowResumer } from './modules/flows/flow-resumer';
import { FxPoller } from './modules/fx/fx-poller';
import { OutboxPoller } from './modules/outbox/outbox-poller';
import { WebhookProcessor } from './modules/payments/webhooks/webhook-processor';
import { ReconciliationScheduler } from './modules/reconciliation/reconciliation-scheduler';
import { ReservationSweeper } from './modules/reservations/reservation-sweeper';
import { WorkerModule } from './worker.module';
import { AdminMonitor } from './modules/admin/break-glass/admin-monitor';
import { hasPaystackKey } from './modules/withdrawals/withdrawals.module';
import { WithdrawalWorkerHeartbeat } from './modules/withdrawals/withdrawal-admission-gate';
import { ProtectedHoldMonitor } from './modules/withdrawals/protected-hold-monitor';
dotenv.config()

async function bootstrap(): Promise<void> {
  const worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(), { bufferLogs: true });
  worker.useLogger(worker.get(Logger));
  const loops: { start(): void; stop(): Promise<void> }[] = [worker.get(OutboxPoller), worker.get(FlowResumer), worker.get(WebhookProcessor), worker.get(ReservationSweeper), worker.get(FxPoller), worker.get(ReconciliationScheduler), worker.get(AdminMonitor), worker.get(ProtectedHoldMonitor, { strict: false })];
  // The withdrawal heartbeat beats only where the withdrawal flows are registered (a Paystack key is configured).
  // The protected-hold monitor (W4 §G.2) runs next to it, always: it pages, it never releases.
  if (hasPaystackKey(process.env)) loops.push(worker.get(WithdrawalWorkerHeartbeat, { strict: false }));
  for (const loop of loops) loop.start();

  const shutdown = async () => {
    await Promise.all(loops.map((loop) => loop.stop()));
    await worker.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

bootstrap().catch((error: unknown) => {
  if (error instanceof ConfigValidationError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`Fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  }
  process.exit(1);
});
