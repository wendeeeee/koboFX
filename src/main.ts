import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { APP_CONFIG } from './config/config.module';
import { AppConfig, ConfigValidationError } from './config/configuration';
dotenv.config()
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(), {
    bufferLogs: true,
    bodyParser: false,
  });
  configureApp(app);
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.port);
}

bootstrap().catch((error: unknown) => {
  if (error instanceof ConfigValidationError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`Fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  }
  process.exit(1);
});
