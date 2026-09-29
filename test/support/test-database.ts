import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { loadConfig } from '../../src/config/configuration';
import { buildDataSourceOptions } from '../../src/database/data-source.options';
import { authenticationTestEnvironment } from './authentication-secrets';

const OWNER_PASSWORD = 'owner_test_pw';
const APP_PASSWORD = 'app_test_pw';
const DB_NAME = 'kobofx_test';

export interface TestDatabase {
  /** Environment for `loadConfig` / `AppModule.forRoot`, pointing at the container. */
  readonly env: Record<string, string>;
  /** A raw client as the schema owner, for setup and assertions outside the app role. */
  ownerClient(): Promise<Client>;
  /** A raw client as the runtime role — what the application actually connects as. */
  appClient(): Promise<Client>;
  /** The container's superuser — for tamper tests that must get past triggers and grants. */
  superuserClient(): Promise<Client>;
  stop(): Promise<void>;
}

/**
 * A real Postgres 16, bootstrapped exactly like dev: roles from
 * docker/postgres/roles.sql, then every migration as fx_owner.
 */
export async function startTestDatabase(overrides: Record<string, string> = {}): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase(DB_NAME)
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  const superuser = new Client({ connectionString: container.getConnectionUri() });
  await superuser.connect();
  const rolesSql = readFileSync(join(__dirname, '../../docker/postgres/roles.sql'), 'utf8')
    .replaceAll('{{FX_OWNER_PASSWORD}}', OWNER_PASSWORD)
    .replaceAll('{{FX_APP_PASSWORD}}', APP_PASSWORD);
  await superuser.query(rolesSql);
  await superuser.end();

  const env: Record<string, string> = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DB_HOST: container.getHost(),
    DB_PORT: String(container.getPort()),
    DB_NAME,
    DB_APP_USER: 'fx_app',
    DB_APP_PASSWORD: APP_PASSWORD,
    DB_MIGRATION_USER: 'fx_owner',
    DB_MIGRATION_PASSWORD: OWNER_PASSWORD,
    DB_POOL_MAX: '10',
    REDIS_URL: 'redis://localhost:6379',
    ROUNDING_USER_CREDIT: 'ROUND_DOWN',
    ROUNDING_USER_DEBIT: 'ROUND_UP',
    ROUNDING_REVENUE: 'ROUND_HALF_EVEN',
    ROUNDING_FEE: 'ROUND_HALF_EVEN',
    ...authenticationTestEnvironment(),
    ...overrides,
  };

  const migrator = new DataSource(buildDataSourceOptions(loadConfig(env).db, 'migration'));
  await migrator.initialize();
  await migrator.runMigrations();
  await migrator.destroy();

  const connect = async (user: string, password: string): Promise<Client> => {
    const client = new Client({
      host: container.getHost(),
      port: container.getPort(),
      database: DB_NAME,
      user,
      password,
    });
    await client.connect();
    return client;
  };

  return {
    env,
    ownerClient: () => connect('fx_owner', OWNER_PASSWORD),
    appClient: () => connect('fx_app', APP_PASSWORD),
    superuserClient: async () => {
      const client = new Client({ connectionString: container.getConnectionUri() });
      await client.connect();
      return client;
    },
    stop: async () => {
      await container.stop();
    },
  };
}
