import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { ConfigValidationError } from './config/configuration';
import { OutboxPoller } from './modules/outbox/outbox-poller';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(), { bufferLogs: true });
  worker.useLogger(worker.get(Logger));
  const poller = worker.get(OutboxPoller);
  poller.start();

  const shutdown = async () => {
    // Finish the in-flight batch; an interrupted delivery is redelivered after its lease.
    await poller.stop();
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
