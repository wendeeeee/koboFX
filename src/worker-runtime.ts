import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
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

export interface RunningWorker {
  readonly context: INestApplicationContext;
  /** Finishes in-flight ticks, then closes the context. */
  stop(): Promise<void>;
}

/** Boots the worker's context and starts every loop: `src/worker.ts` and the single-process demo (`src/demo.ts`). */
export async function startWorker(env: Record<string, string | undefined> = process.env): Promise<RunningWorker> {
  const worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(env), { bufferLogs: true });
  worker.useLogger(worker.get(Logger));
  const loops: { start(): void; stop(): Promise<void> }[] = [worker.get(OutboxPoller), worker.get(FlowResumer), worker.get(WebhookProcessor), worker.get(ReservationSweeper), worker.get(FxPoller), worker.get(ReconciliationScheduler), worker.get(AdminMonitor), worker.get(ProtectedHoldMonitor, { strict: false })];
  // The withdrawal heartbeat beats only where the withdrawal flows are registered (a Paystack key is configured).
  // The protected-hold monitor (W4 §G.2) runs next to it, always: it pages, it never releases.
  if (hasPaystackKey(env)) loops.push(worker.get(WithdrawalWorkerHeartbeat, { strict: false }));
  for (const loop of loops) loop.start();
  return {
    context: worker,
    stop: async () => {
      await Promise.all(loops.map((loop) => loop.stop()));
      await worker.close();
    },
  };
}
