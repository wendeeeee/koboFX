import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { API_PREFIX } from '../src/app.setup';
import { buildOpenApiDocument } from '../src/openapi/openapi-document';
import { RedisService } from '../src/redis/redis.service';
import { authenticationTestEnvironment } from '../test/support/authentication-secrets';

/**
 * Export the real controller graph without connecting to services or running lifecycle hooks.
 * Only synthetic config is used; .env is never loaded. HTTP behaviour is checked separately by
 * openapi-contract.int-spec.ts, which compares its live document with this same artifact.
 */
async function main(): Promise<void> {
  const environment = {
    NODE_ENV: 'test', LOG_LEVEL: 'silent', DB_HOST: '127.0.0.1', DB_PORT: '9', DB_NAME: 'docs',
    DB_APP_USER: 'fx_app', DB_APP_PASSWORD: 'unused', DB_MIGRATION_USER: 'fx_owner', DB_MIGRATION_PASSWORD: 'unused',
    REDIS_URL: 'redis://127.0.0.1:9', ROUNDING_USER_CREDIT: 'ROUND_DOWN', ROUNDING_USER_DEBIT: 'ROUND_UP',
    ROUNDING_REVENUE: 'ROUND_HALF_EVEN', ROUNDING_FEE: 'ROUND_HALF_EVEN',
    ...authenticationTestEnvironment(),
    PAYSTACK_ENABLED: 'true', PAYSTACK_SECRET_KEY: 'sk_test_documentationonly',
    PAYSTACK_BASE_URL: 'http://127.0.0.1:9', PAYSTACK_CALLBACK_URL: 'http://localhost/funding/return',
  };
  const module = await Test.createTestingModule({ imports: [AppModule.forRoot(environment)] })
    .overrideProvider(DataSource).useValue(new DataSource({ type: 'postgres', entities: [] }))
    .overrideProvider(RedisService).useValue({})
    .compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix(API_PREFIX);
  try {
    const document = buildOpenApiDocument(app);
    await SwaggerParser.validate(structuredClone(document) as never);
    writeFileSync(resolve(__dirname, '../docs/openapi.json'), `${JSON.stringify(document, null, 2)}\n`);
    process.stdout.write(`Generated docs/openapi.json with ${Object.keys(document.paths).length} paths (Paystack enabled).\n`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'OpenAPI generation failed'}\n`);
  process.exitCode = 1;
});
