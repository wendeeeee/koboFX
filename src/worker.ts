import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { ConfigValidationError } from './config/configuration';
import { FlowResumer } from './modules/flows/flow-resumer';
import { FxPoller } from './modules/fx/fx-poller';
import { OutboxPoller } from './modules/outbox/outbox-poller';
import { WebhookProcessor } from './modules/payments/webhooks/webhook-processor';
import { ReservationSweeper } from './modules/reservations/reservation-sweeper';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(), { bufferLogs: true });
  worker.useLogger(worker.get(Logger));
  const loops = [worker.get(OutboxPoller), worker.get(FlowResumer), worker.get(WebhookProcessor), worker.get(ReservationSweeper), worker.get(FxPoller)];
  for (const loop of loops) loop.start();

  const shutdown = async () => {
    // Each loop finishes its in-flight batch. Anything interrupted anyway (a hard kill)
    // is picked up after its lease lapses: every step and handler is idempotent.
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
