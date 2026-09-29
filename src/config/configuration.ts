import { KeyObject, createPrivateKey, createPublicKey } from 'node:crypto';
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

export interface AccessTokenConfig {
  /** Key id (`kid`) of the key that signs new tokens; must be in `publicKeys`. */
  readonly signingKeyId: string;
  readonly privateKey: KeyObject;
  /** Every key id still accepted for verification: the current key plus any being rotated out. */
  readonly publicKeys: ReadonlyMap<string, KeyObject>;
  readonly issuer: string;
  readonly audience: string;
  readonly timeToLiveSeconds: number;
}

export interface AuthenticationConfig {
  readonly accessToken: AccessTokenConfig;
  readonly refreshTokenTimeToLiveSeconds: number;
  /** Server-side secret mixed into every one-time password HMAC (design §7.1). */
  readonly oneTimePasswordPepper: Buffer;
  /**
   * Non-production demo credit posted from `EXPENSE:PROMOTIONAL:NGN` at verification
   * (design §15 item 6). `0n` disables it; production refuses anything else.
   */
  readonly demoCreditNgnMinor: bigint;
}

export interface MailConfig {
  readonly smtp: {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly user?: string;
    readonly password?: string;
  };
  readonly from: string;
}

export interface OutboxConfig {
  /** Attempts before an event is dead-lettered (`failed_at`). */
  readonly maxAttempts: number;
  readonly pollIntervalMilliseconds: number;
  readonly batchSize: number;
}

export interface PaymentProviderConfig {
  /** Name recorded on every row this adapter writes (`provider_calls`, `funding_payments`). */
  readonly name: string;
  readonly baseUrl: string;
  /** Our API key at the PSP. Sent as a bearer token; never stored or logged. */
  readonly secretKey: string;
  /** HMAC keys for webhook signatures: the current one first, the previous during a rotation. */
  readonly webhookSecrets: readonly Buffer[];
  readonly webhookToleranceSeconds: number;
  /** Per attempt (design §7.2: 2s). */
  readonly requestTimeoutMilliseconds: number;
  /** Retries on idempotent reads only (design §7.2: 3). */
  readonly readRetries: number;
}

export interface FundingLimit {
  readonly minimumMinor: bigint;
  readonly maximumMinor: bigint;
}

export interface FundingConfig {
  /** Currencies a user may fund; each must be active and have limits. */
  readonly currencies: readonly string[];
  readonly limits: ReadonlyMap<string, FundingLimit>;
}

export interface FlowConfig {
  readonly pollIntervalMilliseconds: number;
  readonly batchSize: number;
  /** How long a claimed flow or webhook event is ours; longer than any step can take. */
  readonly leaseSeconds: number;
  readonly maximumBackoffSeconds: number;
  /** `flows_stalled`: incomplete flows whose state has not changed for this long (design §10: 30 min). */
  readonly stalledAfterMinutes: number;
  /** Webhook processing attempts before an unconfirmed hint is closed (the resumer still owns the flow). */
  readonly webhookMaxAttempts: number;
  readonly reservationSweepIntervalMilliseconds: number;
}

export interface AppConfig {
  readonly env: NodeEnv;
  readonly port: number;
  readonly logLevel: string;
  readonly db: DatabaseConfig;
  readonly redisUrl: string;
  readonly rounding: RoundingConfig;
  readonly ledger: LedgerConfig;
  readonly authentication: AuthenticationConfig;
  readonly mail: MailConfig;
  readonly outbox: OutboxConfig;
  readonly paymentProvider: PaymentProviderConfig;
  readonly funding: FundingConfig;
  readonly flows: FlowConfig;
  /** Reverse proxies in front of the API; `req.ip` is taken from X-Forwarded-For only this deep. */
  readonly trustProxyHops: number;
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

  // Authentication secrets (design §9.1): no defaults, the process refuses to boot
  // without them. PEM material is base64-encoded so it fits in one env line.
  JWT_SIGNING_KEY_ID: Joi.string()
    .pattern(/^[A-Za-z0-9._-]{1,64}$/)
    .required(),
  JWT_PRIVATE_KEY: Joi.string().base64().required(),
  JWT_PUBLIC_KEYS: Joi.string().base64().required(),
  JWT_ISSUER: Joi.string().default('kobofx'),
  JWT_AUDIENCE: Joi.string().default('kobofx-api'),
  ACCESS_TOKEN_TTL_SECONDS: Joi.number().integer().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_SECONDS: Joi.number()
    .integer()
    .min(3600)
    .max(30 * 24 * 3600)
    .default(7 * 24 * 3600),
  ONE_TIME_PASSWORD_PEPPER: Joi.string().base64().required(),
  // A string of minor units, never a number (no floats in the money path).
  DEMO_CREDIT_NGN_MINOR: Joi.string()
    .pattern(/^(0|[1-9]\d{0,17})$/)
    .default('0'),

  SMTP_HOST: Joi.string().hostname().required(),
  SMTP_PORT: Joi.number().port().required(),
  SMTP_SECURE: Joi.boolean().default(false),
  SMTP_USER: Joi.string(),
  SMTP_PASSWORD: Joi.string(),
  MAIL_FROM: Joi.string().required(),

  OUTBOX_MAX_ATTEMPTS: Joi.number().integer().min(1).max(100).default(10),
  OUTBOX_POLL_INTERVAL_MS: Joi.number().integer().min(50).default(1000),
  OUTBOX_BATCH_SIZE: Joi.number().integer().min(1).max(500).default(20),

  TRUST_PROXY_HOPS: Joi.number().integer().min(0).max(10).default(0),

  // The payment service provider (design §7.2, §7.3). Secrets have no defaults.
  PSP_NAME: Joi.string()
    .pattern(/^[a-z0-9-]{1,32}$/)
    .default('simulated-psp'),
  PSP_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required(),
  PSP_SECRET_KEY: Joi.string().min(32).required(),
  // Comma-separated base64 HMAC keys: current first, then the previous during a rotation.
  PSP_WEBHOOK_SECRETS: Joi.string().required(),
  PSP_WEBHOOK_TOLERANCE_SECONDS: Joi.number().integer().min(30).max(900).default(300),
  PSP_REQUEST_TIMEOUT_MILLISECONDS: Joi.number().integer().min(100).max(30_000).default(2000),
  PSP_READ_RETRIES: Joi.number().integer().min(0).max(5).default(3),

  PSP_FUNDING_CURRENCIES: Joi.string()
    .pattern(/^[A-Z]{3}(,[A-Z]{3})*$/)
    .default('NGN'),
  // JSON {currency: {minimum, maximum}}, strings of minor units. Default: NGN ₦100 – ₦1,000,000.
  FUNDING_LIMITS: Joi.string().default('{"NGN":{"minimum":"10000","maximum":"100000000"}}'),

  FLOW_POLL_INTERVAL_MILLISECONDS: Joi.number().integer().min(50).default(1000),
  FLOW_BATCH_SIZE: Joi.number().integer().min(1).max(500).default(20),
  FLOW_LEASE_SECONDS: Joi.number().integer().min(10).max(3600).default(60),
  FLOW_MAXIMUM_BACKOFF_SECONDS: Joi.number().integer().min(5).max(86_400).default(900),
  FLOW_STALLED_AFTER_MINUTES: Joi.number().integer().min(1).default(30),
  WEBHOOK_MAX_ATTEMPTS: Joi.number().integer().min(1).max(100).default(10),
  RESERVATION_SWEEP_INTERVAL_MILLISECONDS: Joi.number().integer().min(100).default(30_000),
})
  .and('SMTP_USER', 'SMTP_PASSWORD')
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
  const problems = error ? error.details.map((d) => d.message) : [];
  const env = (value ?? {}) as Record<string, never>;
  const keys = parseAccessTokenKeys(raw, problems);
  const pepper = typeof raw.ONE_TIME_PASSWORD_PEPPER === 'string' ? Buffer.from(raw.ONE_TIME_PASSWORD_PEPPER, 'base64') : undefined;
  if (pepper && pepper.length < 32) problems.push('ONE_TIME_PASSWORD_PEPPER must decode to at least 32 bytes');
  if (env.NODE_ENV === 'production' && env.DEMO_CREDIT_NGN_MINOR !== undefined && env.DEMO_CREDIT_NGN_MINOR !== '0') {
    problems.push('DEMO_CREDIT_NGN_MINOR must be 0 in production (design §15 item 6: non-production only)');
  }
  const webhookSecrets = parseWebhookSecrets(raw.PSP_WEBHOOK_SECRETS, problems);
  const funding = parseFunding(env.PSP_FUNDING_CURRENCIES, env.FUNDING_LIMITS, problems);
  if (problems.length > 0 || !keys || !pepper || !webhookSecrets || !funding) {
    throw new ConfigValidationError(problems);
  }
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
    authentication: {
      accessToken: {
        signingKeyId: env.JWT_SIGNING_KEY_ID,
        privateKey: keys.privateKey,
        publicKeys: keys.publicKeys,
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        timeToLiveSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
      },
      refreshTokenTimeToLiveSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
      oneTimePasswordPepper: pepper,
      demoCreditNgnMinor: BigInt(env.DEMO_CREDIT_NGN_MINOR),
    },
    mail: {
      smtp: {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        ...(env.SMTP_USER ? { user: env.SMTP_USER, password: env.SMTP_PASSWORD } : {}),
      },
      from: env.MAIL_FROM,
    },
    outbox: {
      maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
      pollIntervalMilliseconds: env.OUTBOX_POLL_INTERVAL_MS,
      batchSize: env.OUTBOX_BATCH_SIZE,
    },
    paymentProvider: {
      name: env.PSP_NAME,
      baseUrl: env.PSP_BASE_URL,
      secretKey: env.PSP_SECRET_KEY,
      webhookSecrets,
      webhookToleranceSeconds: env.PSP_WEBHOOK_TOLERANCE_SECONDS,
      requestTimeoutMilliseconds: env.PSP_REQUEST_TIMEOUT_MILLISECONDS,
      readRetries: env.PSP_READ_RETRIES,
    },
    funding,
    flows: {
      pollIntervalMilliseconds: env.FLOW_POLL_INTERVAL_MILLISECONDS,
      batchSize: env.FLOW_BATCH_SIZE,
      leaseSeconds: env.FLOW_LEASE_SECONDS,
      maximumBackoffSeconds: env.FLOW_MAXIMUM_BACKOFF_SECONDS,
      stalledAfterMinutes: env.FLOW_STALLED_AFTER_MINUTES,
      webhookMaxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
      reservationSweepIntervalMilliseconds: env.RESERVATION_SWEEP_INTERVAL_MILLISECONDS,
    },
    trustProxyHops: env.TRUST_PROXY_HOPS,
  };
}

const MINIMUM_WEBHOOK_SECRET_BYTES = 32;
const MINOR_UNITS_PATTERN = /^[1-9]\d{0,17}$/;

/** One or two base64 HMAC keys of at least 32 bytes each (two only during a rotation). */
function parseWebhookSecrets(value: string | undefined, problems: string[]): Buffer[] | undefined {
  if (!value) return undefined;
  const parts = value.split(',');
  if (parts.length > 2) {
    problems.push('PSP_WEBHOOK_SECRETS holds at most two secrets (current, previous)');
    return undefined;
  }
  const secrets: Buffer[] = [];
  for (const [index, part] of parts.entries()) {
    const decoded = /^[A-Za-z0-9+/]+={0,2}$/.test(part) ? Buffer.from(part, 'base64') : Buffer.alloc(0);
    if (decoded.length < MINIMUM_WEBHOOK_SECRET_BYTES) {
      problems.push(`PSP_WEBHOOK_SECRETS[${index}] must be base64 decoding to at least ${MINIMUM_WEBHOOK_SECRET_BYTES} bytes`);
      return undefined;
    }
    secrets.push(decoded);
  }
  return secrets;
}

/** Funding currencies and their bounds: strings of minor units, every currency covered, min ≤ max. */
function parseFunding(currencyList: string | undefined, limitsJson: string | undefined, problems: string[]): FundingConfig | undefined {
  if (!currencyList || !limitsJson) return undefined;
  const currencies = [...new Set(currencyList.split(','))];
  let parsed: unknown;
  try {
    parsed = JSON.parse(limitsJson);
  } catch {
    problems.push('FUNDING_LIMITS must be JSON');
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    problems.push('FUNDING_LIMITS must map currency to {minimum, maximum}');
    return undefined;
  }
  const limits = new Map<string, FundingLimit>();
  for (const currency of currencies) {
    const entry = (parsed as Record<string, unknown>)[currency] as { minimum?: unknown; maximum?: unknown } | undefined;
    const { minimum, maximum } = entry ?? {};
    if (
      typeof minimum !== 'string' || typeof maximum !== 'string' ||
      !MINOR_UNITS_PATTERN.test(minimum) || !MINOR_UNITS_PATTERN.test(maximum)
    ) {
      problems.push(`FUNDING_LIMITS.${currency} needs minimum and maximum as positive strings of minor units`);
      continue;
    }
    if (BigInt(minimum) > BigInt(maximum)) {
      problems.push(`FUNDING_LIMITS.${currency}: minimum exceeds maximum`);
      continue;
    }
    limits.set(currency, { minimumMinor: BigInt(minimum), maximumMinor: BigInt(maximum) });
  }
  return limits.size === currencies.length ? { currencies, limits } : undefined;
}

const MINIMUM_RSA_MODULUS_BITS = 2048;

/**
 * Parse and cross-check the RS256 key material (design §9.1). Appends every problem
 * it finds; returns undefined when the keys are unusable.
 *
 * - Every key is RSA with a modulus of at least 2048 bits.
 * - The signing key id is one of the published verification keys, and the private
 *   key matches that public key — otherwise every token we issue would be refused.
 */
function parseAccessTokenKeys(
  raw: Record<string, string | undefined>,
  problems: string[],
): { privateKey: KeyObject; publicKeys: Map<string, KeyObject> } | undefined {
  const { JWT_PRIVATE_KEY, JWT_PUBLIC_KEYS, JWT_SIGNING_KEY_ID } = raw;
  if (!JWT_PRIVATE_KEY || !JWT_PUBLIC_KEYS || !JWT_SIGNING_KEY_ID) return undefined;
  const isStrongRsa = (key: KeyObject) =>
    key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= MINIMUM_RSA_MODULUS_BITS;

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(Buffer.from(JWT_PRIVATE_KEY, 'base64').toString('utf8'));
  } catch {
    problems.push('JWT_PRIVATE_KEY is not a valid base64-encoded PEM private key');
    return undefined;
  }
  if (!isStrongRsa(privateKey)) problems.push(`JWT_PRIVATE_KEY must be an RSA key of at least ${MINIMUM_RSA_MODULUS_BITS} bits`);

  let entries: [string, unknown][];
  try {
    const parsed: unknown = JSON.parse(Buffer.from(JWT_PUBLIC_KEYS, 'base64').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    entries = Object.entries(parsed);
  } catch {
    problems.push('JWT_PUBLIC_KEYS must be base64-encoded JSON mapping key id to PEM public key');
    return undefined;
  }
  const publicKeys = new Map<string, KeyObject>();
  for (const [keyId, pem] of entries) {
    try {
      if (typeof pem !== 'string') throw new Error('not a string');
      const key = createPublicKey(pem);
      if (!isStrongRsa(key)) {
        problems.push(`JWT_PUBLIC_KEYS[${keyId}] must be an RSA key of at least ${MINIMUM_RSA_MODULUS_BITS} bits`);
      }
      publicKeys.set(keyId, key);
    } catch {
      problems.push(`JWT_PUBLIC_KEYS[${keyId}] is not a valid PEM public key`);
    }
  }
  const signingPublicKey = publicKeys.get(JWT_SIGNING_KEY_ID);
  if (!signingPublicKey) {
    problems.push('JWT_SIGNING_KEY_ID must name a key in JWT_PUBLIC_KEYS');
  } else if (!createPublicKey(privateKey).equals(signingPublicKey)) {
    problems.push('JWT_PRIVATE_KEY does not match the public key published under JWT_SIGNING_KEY_ID');
  }
  return { privateKey, publicKeys };
}
