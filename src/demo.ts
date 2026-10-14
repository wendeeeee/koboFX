import 'reflect-metadata';
import { Server } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { ConfigValidationError, DatabaseConfig, loadConfig } from './config/configuration';
import { buildDataSourceOptions } from './database/data-source.options';
import { parseMockPaystackSeed } from './mock-paystack/dev-seed';
import { MockPaystack } from './mock-paystack/mock-paystack';
import { MockPsp } from './mock-psp/mock-psp';
import { startWorker } from './worker-runtime';

/**
 * The hosted test-mode demo as ONE process (render.yaml, docs/DEPLOY_RENDER.md). Render's free web services cannot
 * RECEIVE private-network traffic, so the customer UI, the API, the worker and both simulated providers share one
 * container: only the UI listens publicly (on `PORT`); everything else binds 127.0.0.1.
 *
 * Start-up order: environment → the runtime database role (idempotent) → migrations → API → worker → simulated
 * providers → UI. The public port opens last, so the platform sees the service up only when all of it is.
 *
 * Never for real money: the demo runs NODE_ENV=development with test keys and simulated withdrawals (config refuses
 * those in production).
 */

export interface DemoPorts {
  readonly publicPort: number;
  readonly apiPort: number;
  readonly mockPaystackPort: number;
  readonly mockPspPort: number;
}

/**
 * Fills the settings the single-process layout implies, without overriding anything set explicitly:
 * - `PORT` is the platform's public port: it becomes the UI's, and the API moves to `DEMO_API_PORT` (3000);
 * - `DATABASE_URL` (Render's connection string, the schema owner) → `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_MIGRATION_*`;
 * - `RENDER_GIT_COMMIT` → `BUILD_GIT_SHA` (what /health reports);
 * - the simulated providers and the UI proxy point at the API on 127.0.0.1.
 */
export function prepareDemoEnvironment(env: Record<string, string | undefined>): DemoPorts {
  const ports: DemoPorts = {
    publicPort: Number(env.PORT ?? '10000'),
    apiPort: Number(env.DEMO_API_PORT ?? '3000'),
    mockPaystackPort: Number(env.MOCK_PAYSTACK_PORT ?? '4030'),
    mockPspPort: Number(env.MOCK_PSP_PORT ?? '4010'),
  };
  env.PORT = String(ports.apiPort);
  if (env.DATABASE_URL) {
    const url = new URL(env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must be a postgres:// connection string');
    env.DB_HOST ??= url.hostname;
    env.DB_PORT ??= url.port || '5432';
    env.DB_NAME ??= decodeURIComponent(url.pathname.replace(/^\//, ''));
    env.DB_MIGRATION_USER ??= decodeURIComponent(url.username);
    env.DB_MIGRATION_PASSWORD ??= decodeURIComponent(url.password);
  }
  env.BUILD_GIT_SHA ??= env.RENDER_GIT_COMMIT;
  const api = `http://127.0.0.1:${ports.apiPort}`;
  env.MOCK_PAYSTACK_WEBHOOK_URL ??= `${api}/api/v1/webhooks/paystack`;
  env.MOCK_PSP_WEBHOOK_URL ??= `${api}/api/v1/webhooks/psp`;
  env.UI_API_ORIGIN = api;
  env.UI_PORT = String(ports.publicPort);
  env.UI_HOST ??= '0.0.0.0';
  return ports;
}

/**
 * The runtime role on a managed database whose user owns the database but is not a superuser (Render): the
 * `docker/postgres/roles.sql` model, with the platform's user as the schema owner. Every migration grants to the
 * runtime role by name; none names the owner. Idempotent; keeps the role's password equal to `DB_APP_PASSWORD`.
 */
export async function ensureRuntimeRole(db: DatabaseConfig): Promise<void> {
  const client = new Client({ host: db.host, port: db.port, database: db.name, user: db.migration.user, password: db.migration.password });
  await client.connect();
  try {
    const role = client.escapeIdentifier(db.app.user);
    const database = client.escapeIdentifier(db.name);
    const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [db.app.user]);
    await client.query(`${rowCount ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN PASSWORD ${client.escapeLiteral(db.app.password)}`);
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await client.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${database} TO ${role}`);
    await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`);
  } catch (error) {
    if ((error as { code?: string }).code === '42501') {
      throw new Error(
        `The database user "${db.migration.user}" may not create the runtime role "${db.app.user}" (${(error as Error).message}). ` +
          'Use a database whose user has CREATEROLE (docs/DEPLOY_RENDER.md, "If the role cannot be created").',
      );
    }
    throw error;
  } finally {
    await client.end();
  }
}

// The UI server is an ES module; a CommonJS build would turn `import()` into `require()`, which cannot load it.
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ server: Server }>;

async function main(): Promise<void> {
  const ports = prepareDemoEnvironment(process.env);
  const config = loadConfig(process.env);
  const log = (message: string) => process.stdout.write(`[demo] ${message}\n`);

  await ensureRuntimeRole(config.db);
  const migrations = new DataSource(buildDataSourceOptions(config.db, 'migration'));
  await migrations.initialize();
  try {
    const applied = await migrations.runMigrations({ transaction: 'each' });
    log(`migrations: ${applied.length} applied`);
  } finally {
    await migrations.destroy();
  }

  const api = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(process.env), { bufferLogs: true, bodyParser: false });
  configureApp(api);
  await api.listen(ports.apiPort, '127.0.0.1');
  log(`API on 127.0.0.1:${ports.apiPort}`);

  const worker = await startWorker(process.env);
  log('worker loops started');

  const psp = new MockPsp({
    secretKey: config.paymentProvider.secretKey,
    webhookSecret: config.paymentProvider.webhookSecrets[0]!,
    captureCompletion: { afterMilliseconds: Number(process.env.MOCK_PSP_CAPTURE_DELAY_MS ?? '2000') },
    autoDeliverWebhooks: true,
    deliverWebhook: async (body, headers) => (await fetch(process.env.MOCK_PSP_WEBHOOK_URL!, { method: 'POST', body, headers })).status,
  });
  await psp.start(ports.mockPspPort, '127.0.0.1');
  let paystack: MockPaystack | null = null;
  if (config.paystack.secretKey) {
    if (config.paystack.secretKey.startsWith('sk_live_')) throw new Error('Refusing to run the simulated Paystack with a live key');
    const seed = parseMockPaystackSeed(process.env);
    paystack = new MockPaystack({
      secretKey: config.paystack.secretKey,
      autoDeliverWebhooks: true,
      deliverWebhook: async (body, headers) => (await fetch(process.env.MOCK_PAYSTACK_WEBHOOK_URL!, { method: 'POST', body, headers })).status,
    });
    for (const account of seed.accounts) paystack.transfers.addAccount(account.bankCode, account.accountNumber, account.accountName);
    paystack.transfers.setBalance(seed.balanceMinor);
    paystack.transfers.setNextTransfer({ status: seed.transferStatus, fee: seed.transferFeeMinor, domain: 'test' });
    await paystack.start(ports.mockPaystackPort, '127.0.0.1');
  }
  log(`simulated PSP on :${ports.mockPspPort}${paystack ? `, simulated Paystack on :${ports.mockPaystackPort}` : ''}`);

  const { server: ui } = await importModule(pathToFileURL(resolve(__dirname, '..', 'ui', 'server.mjs')).href);
  await new Promise<void>((done) => ui.listen(ports.publicPort, process.env.UI_HOST, done));
  log(`UI on ${process.env.UI_HOST}:${ports.publicPort}: ready`);

  const shutdown = async () => {
    await new Promise<void>((done) => ui.close(() => done()));
    await Promise.all([psp.stop(), paystack?.stop()]);
    await worker.stop();
    await api.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

if (require.main === module) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigValidationError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`Fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    }
    process.exit(1);
  });
}
