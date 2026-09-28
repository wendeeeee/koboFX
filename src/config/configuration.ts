import Joi from 'joi';
import { RoundingConfig, RoundingPurpose, RoundingStrategy } from '../common/money/rounding-policy';

export type NodeEnv = 'development' | 'test' | 'production';

export interface DatabaseCredentials {
  readonly user: string;
  readonly password: string;
}

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly name: string;
  /** Runtime role: DML only. */
  readonly app: DatabaseCredentials;
  /** Schema owner: migrations only. */
  readonly migration: DatabaseCredentials;
  readonly poolMax: number;
  /** design §6.6: a pathological lock wait becomes a clean 503, not a drained pool. */
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export interface LedgerConfig {
  /**
   * Rows per internal (system) account per currency (design §6.6). Raising it is
   * config plus re-running provisioning; lowering it is refused at provisioning,
   * because balances in the higher buckets would become unreachable.
   */
  readonly internalAccountBuckets: number;
}

export interface AppConfig {
  readonly env: NodeEnv;
  readonly port: number;
  readonly logLevel: string;
  readonly db: DatabaseConfig;
  readonly redisUrl: string;
  readonly rounding: RoundingConfig;
  readonly ledger: LedgerConfig;
}

const strategies = Object.values(RoundingStrategy);

const envSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),

  DB_HOST: Joi.string().hostname().required(),
  DB_PORT: Joi.number().port().default(5432),
  DB_NAME: Joi.string().required(),
  DB_APP_USER: Joi.string().required(),
  DB_APP_PASSWORD: Joi.string().required(),
  DB_MIGRATION_USER: Joi.string().required(),
  DB_MIGRATION_PASSWORD: Joi.string().required(),
  DB_POOL_MAX: Joi.number().integer().min(1).max(200).default(20),
  DB_LOCK_TIMEOUT_MS: Joi.number().integer().min(1).default(3000),
  DB_STATEMENT_TIMEOUT_MS: Joi.number().integer().min(1).default(10_000),

  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),

  // accounts.bucket is SMALLINT.
  LEDGER_INTERNAL_BUCKETS: Joi.number().integer().min(1).max(1024).default(64),

  // No defaults: rounding is a business decision, and a missing one must not be
  // silently filled in (design §4.4).
  ROUNDING_USER_CREDIT: Joi.string()
    .valid(...strategies)
    .required(),
  ROUNDING_REVENUE: Joi.string()
    .valid(...strategies)
    .required(),
  ROUNDING_FEE: Joi.string()
    .valid(...strategies)
    .required(),
})
  // The runtime and migration roles must differ, or the ledger's revoked grants are void.
  .custom((env: Record<string, unknown>, helpers) =>
    env.DB_APP_USER === env.DB_MIGRATION_USER
      ? helpers.message({ custom: 'DB_APP_USER must differ from DB_MIGRATION_USER' })
      : env,
  )
  .unknown(true);

export class ConfigValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Validate the environment and build typed config. Fails fast, reporting every
 * problem at once — the process must not boot on a bad config (design §9.1).
 */
export function loadConfig(raw: NodeJS.ProcessEnv | Record<string, string | undefined>): AppConfig {
  const { error, value } = envSchema.validate(raw, { abortEarly: false, convert: true });
  if (error) {
    throw new ConfigValidationError(error.details.map((d) => d.message));
  }
  const env = value as Record<string, never>;
  return {
    env: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    db: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      name: env.DB_NAME,
      app: { user: env.DB_APP_USER, password: env.DB_APP_PASSWORD },
      migration: { user: env.DB_MIGRATION_USER, password: env.DB_MIGRATION_PASSWORD },
      poolMax: env.DB_POOL_MAX,
      lockTimeoutMs: env.DB_LOCK_TIMEOUT_MS,
      statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
    },
    redisUrl: env.REDIS_URL,
    rounding: {
      [RoundingPurpose.USER_CREDIT]: env.ROUNDING_USER_CREDIT,
      [RoundingPurpose.REVENUE]: env.ROUNDING_REVENUE,
      [RoundingPurpose.FEE]: env.ROUNDING_FEE,
    },
    ledger: {
      internalAccountBuckets: env.LEDGER_INTERNAL_BUCKETS,
    },
  };
}
