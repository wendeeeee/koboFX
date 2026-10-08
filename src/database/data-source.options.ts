import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { DatabaseConfig } from '../config/configuration';
import { MIGRATIONS } from './migrations';

export type DatabaseRole = 'app' | 'migration';

/**
 * Connection options per role. The app role gets session-level timeouts on every
 * pooled connection; migrations run without them, as the schema owner.
 *
 * `synchronize` is off everywhere: the schema changes only through reviewed migrations.
 * BIGINT and NUMERIC come back from `pg` as strings by default. Numeric parsing is disabled so no amount ever passes through a JS number.
 */
export function buildDataSourceOptions(
  db: DatabaseConfig,
  role: DatabaseRole,
): PostgresConnectionOptions {
  const credentials = role === 'app' ? db.app : db.migration;
  const sessionOptions =
    role === 'app'
      ? `-c lock_timeout=${db.lockTimeoutMs} -c statement_timeout=${db.statementTimeoutMs} -c TimeZone=UTC`
      : '-c TimeZone=UTC';
  return {
    type: 'postgres',
    host: db.host,
    port: db.port,
    database: db.name,
    username: credentials.user,
    password: credentials.password,
    applicationName: `kobofx-${role}`,
    synchronize: false,
    migrationsRun: false,
    migrations: MIGRATIONS,
    migrationsTransactionMode: 'each',
    extra: {
      max: role === 'app' ? db.poolMax : 2,
      options: sessionOptions,
    },
  };
}
