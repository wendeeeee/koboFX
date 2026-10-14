import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { ConfigValidationError } from './config/configuration';
import { startWorker } from './worker-runtime';
dotenv.config()

async function bootstrap(): Promise<void> {
  const worker = await startWorker();
  const shutdown = async () => {
    await worker.stop();
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
