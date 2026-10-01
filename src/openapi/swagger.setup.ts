import { NestExpressApplication } from '@nestjs/platform-express';
import { OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import type { Request } from 'express';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/configuration';
import { buildOpenApiDocument } from './openapi-document';

/**
 * Serve the OpenAPI document (Phase 11): Swagger UI at `/{prefix}/docs`, JSON at `/{prefix}/docs-json`. Off unless
 * `API_DOCS_ENABLED` (default: on outside production). These are plain Express routes, outside the Nest guard chain:
 * they expose the contract only, never data. helmet's default CSP applies unchanged — Swagger UI loads every script
 * and stylesheet from this origin (no inline script), which the contract test pins.
 *
 * The UI FETCHES the document from `/{prefix}/docs-json` instead of embedding it in `swagger-ui-init.js`:
 * `@nestjs/swagger` 11.4 embeds it with `template.replace('<% swaggerOptions %>', json)` — a STRING replacement, where
 * `` $` ``, `$'`, `$&` and `$$` are patterns — so a description quoting a regex such as `` `^[A-Z]{3}$` `` corrupts the
 * script and the UI renders nothing (found by loading the UI in Chromium). The init script therefore gets an empty
 * document (Swagger UI then loads `swaggerUrl`); the JSON route serves the real one. One source, nothing to escape.
 *
 * The document is built on the first request and cached (the module graph is complete by then).
 */
export function configureSwagger(app: NestExpressApplication, prefix: string): void {
  if (!app.get<AppConfig>(APP_CONFIG).apiDocsEnabled) return;
  let document: OpenAPIObject | undefined;
  const documentOnce = (): OpenAPIObject => (document ??= buildOpenApiDocument(app));
  const jsonDocumentUrl = `${prefix}/docs-json`;
  SwaggerModule.setup(`${prefix}/docs`, app, documentOnce, {
    useGlobalPrefix: false,
    raw: ['json'],
    jsonDocumentUrl,
    swaggerUrl: `/${jsonDocumentUrl}`,
    patchDocumentOnRequest: <TRequest, TResponse>(request: TRequest, _response: TResponse, full: OpenAPIObject) =>
      (request as unknown as Request).path.endsWith('/swagger-ui-init.js') ? ({} as OpenAPIObject) : full,
    customSiteTitle: 'KoboFX API',
    swaggerOptions: { persistAuthorization: false, displayOperationId: false },
  });
}
