import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { raw } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { correlationIdMiddleware } from './common/context';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { APP_CONFIG } from './config/config.module';
import { AppConfig } from './config/configuration';

export const API_PREFIX = 'api/v1';

/** Body cap (design §9.1). */
export const BODY_LIMIT = '100kb';

/** The one route that needs the verbatim request bytes (design §7.3: HMAC over the raw body). */
export const PSP_WEBHOOK_PATH = `/${API_PREFIX}/webhooks/psp`;

/**
 * HTTP pipeline shared by `main.ts` and the e2e harness, so tests exercise the real
 * one. The app must be created with `{ bodyParser: false }`.
 */
export function configureApp(app: NestExpressApplication): void {
  // First: everything downstream runs inside the request's correlation context.
  app.use(correlationIdMiddleware);
  app.useLogger(app.get(Logger));
  app.use(helmet());
  // `req.ip` — the rate limiter's key — honours X-Forwarded-For only through our own proxies.
  app.set('trust proxy', app.get<AppConfig>(APP_CONFIG).trustProxyHops);
  // The webhook's bytes are read raw (a Buffer, same cap) BEFORE the JSON parser, which
  // then skips the already-consumed stream. Every other route parses JSON exactly as before.
  app.use(PSP_WEBHOOK_PATH, raw({ type: () => true, limit: BODY_LIMIT }));
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
}
