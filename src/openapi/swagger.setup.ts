import { NestExpressApplication } from '@nestjs/platform-express';
import { OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import type { Request } from 'express';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/configuration';
import { buildOpenApiDocument } from './openapi-document';


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
