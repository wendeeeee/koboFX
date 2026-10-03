import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { raw } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { correlationIdMiddleware } from './common/context';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { APP_CONFIG } from './config/config.module';
import { AppConfig } from './config/configuration';
import { configureSwagger } from './openapi/swagger.setup';

export const API_PREFIX = 'api/v1';

export const BODY_LIMIT = '100kb';

export const PSP_WEBHOOK_PATH = `/${API_PREFIX}/webhooks/psp`;
export const PAYSTACK_WEBHOOK_PATH = `/${API_PREFIX}/webhooks/paystack`;


export function configureApp(app: NestExpressApplication): void {
  app.use(correlationIdMiddleware);
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.set('trust proxy', app.get<AppConfig>(APP_CONFIG).trustProxyHops);
  app.use(PSP_WEBHOOK_PATH, raw({ type: () => true, limit: BODY_LIMIT }));
  app.use(PAYSTACK_WEBHOOK_PATH, raw({ type: () => true, limit: BODY_LIMIT }));
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  configureSwagger(app, API_PREFIX);
}
