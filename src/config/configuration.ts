import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KeyObject, createPrivateKey, createPublicKey } from 'node:crypto';
import Joi from 'joi';
import { RoundingConfig, RoundingPurpose, RoundingStrategy } from '../common/money/rounding-policy';
import { PROVIDER_PLAN_PROFILES, ProviderPlan } from '../modules/fx/provider-plan';

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

/**
 * Paystack, the second funding provider (test mode; `PAYSTACK_PLAN.md`). One account, one key: a second account
 * would be another provider instance, explicitly configured, never guessed.
 */
export interface PaystackConfig {
  /** Off: the routes are not registered (404), the worker never calls Paystack, the spec leaves them out. */
  readonly enabled: boolean;
  /** Recorded on every row (`funding_payments.provider`, `webhook_events`, `provider_calls`, runs). */
  readonly name: 'paystack';
  /** `sk_test_…` / `sk_live_…`. Sent only as a bearer token; never stored, logged or put in an error. Empty when off. */
  readonly secretKey: string;
  readonly baseUrl: string;
  /** Where the customer's BROWSER returns after paying (a client page, not this API). Carries no authority. */
  readonly callbackUrl: string;
  readonly currencies: readonly string[];
  /** Inside it, a non-success verify answer means "not yet"; after it, `abandoned` / `failed` / not found are final. */
  readonly checkoutWindowMinutes: number;
  /** When set, a webhook from any other `req.ip` is stored and refused (fail-closed). */
  readonly webhookIpAllowlist: readonly string[] | null;
  /** Per attempt, for reads. */
  readonly requestTimeoutMilliseconds: number;
  /** Initialize is sent once: a longer budget makes "accepted but the answer was lost" rarer. */
  readonly initializeTimeoutMilliseconds: number;
  readonly readRetries: number;
}

export const PAYSTACK_PROVIDER_NAME = 'paystack';

export interface FundingLimit {
  readonly minimumMinor: bigint;
  readonly maximumMinor: bigint;
}

export interface FundingConfig {
  /** Currencies a user may fund through the simulated PSP; each must be active and have limits. */
  readonly currencies: readonly string[];
  /** One limit set for every provider: covers these AND Paystack's currencies. */
  readonly limits: ReadonlyMap<string, FundingLimit>;
}

export interface ConversionLimit {
  /** The largest single conversion from this currency, in its minor units. */
  readonly maximumMinor: bigint;
  /** The most one user may convert from this currency in any rolling 24 hours, in its minor units. */
  readonly dailyMaximumMinor: bigint;
}

export interface ConversionConfig {
  /** Per SOURCE currency. A currency with no entry cannot be converted from (checked at boot). */
  readonly limits: ReadonlyMap<string, ConversionLimit>;
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

/** A decimal string; converted to `Decimal` where used (never a float). */
export type DecimalString = string;

export interface FxRateBounds {
  readonly minimum: DecimalString;
  readonly maximum: DecimalString;
}

export interface FxConfig {
  /** Name recorded on every `provider_calls` and `exchange_rate_snapshots` row. */
  readonly providerName: string;
  /**
   * `FX_RATE_BASE_URL`, up to and including `/latest` (the adapter appends `/USD`). May hold
   * an `{apiKey}` placeholder (the keyed v6 endpoint puts the key in the path); the
   * open-access endpoint needs none.
   */
  readonly baseUrl: string;
  /** Only with an `{apiKey}` URL. Never recorded, logged or put in an error message. */
  readonly apiKey: string | undefined;
  readonly plan: ProviderPlan;
  readonly cadenceSeconds: number;
  readonly monthlyRequestBudget: number;
  readonly dailyRequestBudget: number;
  readonly executableMaximumAgeSeconds: number;
  readonly displayMaximumAgeSeconds: number;
  readonly publicationGraceSeconds: number;
  readonly latePublicationRetrySeconds: number;
  readonly maximumJumpRatio: DecimalString;
  readonly jumpRatioOverrides: ReadonlyMap<string, DecimalString>;
  /** Loose plausibility bounds per currency (USD-based mid); required for every active currency. */
  readonly rateBounds: ReadonlyMap<string, FxRateBounds>;
  readonly quoteTimeToLiveSeconds: number;
  /** Per attempt (design §7.2: 2s); also the synchronous catch-up budget. */
  readonly requestTimeoutMilliseconds: number;
  readonly readRetries: number;
  /** How often the worker's poller wakes to ask "is a fetch due?" (the schedule decides). */
  readonly pollIntervalMilliseconds: number;
  /** How long a process may serve a snapshot from memory before re-reading Redis. */
  readonly localCacheMilliseconds: number;
}

export interface SettlementWindow {
  /** T+X: business days (UTC Mon–Fri) after the capture date by which the PSP should settle. */
  readonly businessDays: number;
  /** Slack after the end of that day before an unsettled deposit is a break. */
  readonly graceHours: number;
}

/** A UTC time of day. */
export interface TimeOfDay {
  readonly hour: number;
  readonly minute: number;
}

/** Controls (Phase 10; design §9.2–§9.4). */
export interface AdminConfig {
  /** A PENDING approval nobody decided within this is refused and swept to EXPIRED. */
  readonly approvalTimeToLiveHours: number;
  /** A break-glass use must be reviewed by SECURITY within this, or it pages. */
  readonly breakGlassReviewHours: number;
  /** A four-eyes manual rate is executable at most this long. */
  readonly manualRateMaximumValiditySeconds: number;
  /** A break-glass (single-actor) manual rate: shorter. */
  readonly breakGlassManualRateMaximumValiditySeconds: number;
  /** How often the worker's monitor sweeps expired approvals and overdue break-glass reviews. */
  readonly monitorTickMilliseconds: number;
  /** The build's git SHA (design §9.4), injected at build time; `unknown` only outside production. */
  readonly buildGitSha: string;
}

export interface ReconciliationConfig {
  /** Run the scheduler loop in the worker. */
  readonly enabled: boolean;
  /** How often the scheduler wakes to ask "is a run due?". */
  readonly tickMilliseconds: number;
  /** When the nightly internal run (design §8.1) is due, UTC. */
  readonly internalAt: TimeOfDay;
  /** When the daily external run (design §8.2) is due, UTC. */
  readonly externalDailyAt: TimeOfDay;
  /** Minute past each hour the hourly sweep is due. */
  readonly externalHourlyMinute: number;
  /** How long a claimed run is ours before another worker may resume it. */
  readonly leaseSeconds: number;
  /** The internal run's own statement timeout, inside its read-only snapshot (Phase 9 §H.7). */
  readonly statementTimeoutSeconds: number;
  /** How far back each external run re-reads the PSP (settlements and payments). */
  readonly lookbackDays: number;
  /** A deposit the PSP captured this long ago that we have not booked is a break (the webhook never came). */
  readonly unresolvedFlowAgeMinutes: number;
  /** T+X per currency; required for every funding currency (checked at boot). */
  readonly settlementWindows: ReadonlyMap<string, SettlementWindow>;
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
  readonly paystack: PaystackConfig;
  readonly funding: FundingConfig;
  readonly conversion: ConversionConfig;
  readonly flows: FlowConfig;
  readonly fx: FxConfig;
  readonly reconciliation: ReconciliationConfig;
  readonly admin: AdminConfig;
  /** Reverse proxies in front of the API; `req.ip` is taken from X-Forwarded-For only this deep. */
  readonly trustProxyHops: number;
  /** Serve the OpenAPI document and Swagger UI (`/api/v1/docs`). Off by default in production (Phase 11). */
  readonly apiDocsEnabled: boolean;
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
  ROUNDING_USER_DEBIT: Joi.string()
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
  API_DOCS_ENABLED: Joi.boolean().optional(),

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

  // Paystack (PAYSTACK_PLAN.md). The key is required only when enabled; its prefix is checked against NODE_ENV.
  PAYSTACK_ENABLED: Joi.boolean().default(false),
  PAYSTACK_SECRET_KEY: Joi.string().pattern(/^sk_(test|live)_[A-Za-z0-9]{8,128}$/, 'a Paystack secret key (sk_test_… or sk_live_…)'),
  PAYSTACK_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('https://api.paystack.co'),
  PAYSTACK_CALLBACK_URL: Joi.string().uri({ scheme: ['http', 'https'] }),
  PAYSTACK_FUNDING_CURRENCIES: Joi.string()
    .pattern(/^[A-Z]{3}(,[A-Z]{3})*$/)
    .default('NGN'),
  PAYSTACK_CHECKOUT_WINDOW_MINUTES: Joi.number().integer().min(5).max(24 * 60).default(30),
  PAYSTACK_WEBHOOK_IP_ALLOWLIST: Joi.string().pattern(/^[0-9a-fA-F.:]+(,[0-9a-fA-F.:]+)*$/),
  PAYSTACK_REQUEST_TIMEOUT_MILLISECONDS: Joi.number().integer().min(100).max(30_000).default(5000),
  PAYSTACK_INITIALIZE_TIMEOUT_MILLISECONDS: Joi.number().integer().min(1000).max(60_000).default(10_000),
  PAYSTACK_READ_RETRIES: Joi.number().integer().min(0).max(5).default(3),

  PSP_FUNDING_CURRENCIES: Joi.string()
    .pattern(/^[A-Z]{3}(,[A-Z]{3})*$/)
    .default('NGN'),
  // JSON {currency: {minimum, maximum}}, strings of minor units. Default: NGN ₦100 – ₦1,000,000.
  FUNDING_LIMITS: Joi.string().default('{"NGN":{"minimum":"10000","maximum":"100000000"}}'),

  // JSON {currency: {maximum, dailyMaximum}} per SOURCE currency, strings of minor units.
  // Default: ₦10,000,000 / $10,000 / €10,000 / £10,000 per conversion, five times that per rolling 24h.
  CONVERSION_LIMITS: Joi.string().default(
    JSON.stringify({
      NGN: { maximum: '1000000000', dailyMaximum: '5000000000' },
      USD: { maximum: '1000000', dailyMaximum: '5000000' },
      EUR: { maximum: '1000000', dailyMaximum: '5000000' },
      GBP: { maximum: '1000000', dailyMaximum: '5000000' },
    }),
  ),

  FLOW_POLL_INTERVAL_MILLISECONDS: Joi.number().integer().min(50).default(1000),
  FLOW_BATCH_SIZE: Joi.number().integer().min(1).max(500).default(20),
  FLOW_LEASE_SECONDS: Joi.number().integer().min(10).max(3600).default(60),
  FLOW_MAXIMUM_BACKOFF_SECONDS: Joi.number().integer().min(5).max(86_400).default(900),
  FLOW_STALLED_AFTER_MINUTES: Joi.number().integer().min(1).default(30),
  WEBHOOK_MAX_ATTEMPTS: Joi.number().integer().min(1).max(100).default(10),
  RESERVATION_SWEEP_INTERVAL_MILLISECONDS: Joi.number().integer().min(100).default(30_000),

  // Reconciliation (Phase 9; design §8). Times are UTC.
  APPROVAL_TTL_HOURS: Joi.number().integer().min(1).max(24 * 30).default(72),
  BREAK_GLASS_REVIEW_HOURS: Joi.number().integer().min(1).max(24 * 7).default(24),
  MANUAL_RATE_MAXIMUM_VALIDITY_SECONDS: Joi.number().integer().min(60).max(86_400).default(3_600),
  BREAK_GLASS_MANUAL_RATE_MAXIMUM_VALIDITY_SECONDS: Joi.number().integer().min(60).max(86_400).default(900),
  ADMIN_MONITOR_TICK_MILLISECONDS: Joi.number().integer().min(50).default(60_000),
  BUILD_GIT_SHA: Joi.string().pattern(/^[0-9a-f]{7,40}$/).optional(),
  RECONCILIATION_ENABLED: Joi.boolean().default(true),
  RECONCILIATION_TICK_MILLISECONDS: Joi.number().integer().min(50).default(60_000),
  RECONCILIATION_INTERNAL_AT: Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).default('01:00'),
  RECONCILIATION_EXTERNAL_DAILY_AT: Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).default('02:00'),
  RECONCILIATION_EXTERNAL_HOURLY_MINUTE: Joi.number().integer().min(0).max(59).default(15),
  RECONCILIATION_LEASE_SECONDS: Joi.number().integer().min(10).max(86_400).default(300),
  RECONCILIATION_STATEMENT_TIMEOUT_SECONDS: Joi.number().integer().min(1).max(86_400).default(900),
  RECONCILIATION_LOOKBACK_DAYS: Joi.number().integer().min(1).max(400).default(35),
  RECONCILIATION_UNRESOLVED_FLOW_AGE_MINUTES: Joi.number().integer().min(1).default(60),
  SETTLEMENT_WINDOWS: Joi.string().default('{"NGN":{"businessDays":2,"graceHours":24}}'),

  // FX rates (design §7.2, §7.4; Phase 6). One provider, ExchangeRate-API, behind a port.
  // Validated as a URL in parseFx, after the {apiKey} placeholder (braces are not URI characters).
  FX_RATE_BASE_URL: Joi.string().max(2048).default('https://open.er-api.com/v6/latest'),
  EXCHANGE_RATE_API_KEY: Joi.string().pattern(/^[A-Za-z0-9]{8,64}$/),
  FX_PROVIDER_NAME: Joi.string()
    .pattern(/^[a-z0-9-]{1,32}$/)
    .default('exchange-rate-api'),
  FX_PROVIDER_PLAN: Joi.string()
    .valid(...Object.values(ProviderPlan))
    .default(ProviderPlan.OPEN),
  FX_MONTHLY_REQUEST_BUDGET: Joi.number().integer().min(1),
  FX_DAILY_REQUEST_BUDGET: Joi.number().integer().min(1),
  FX_EXECUTABLE_MAXIMUM_RATE_AGE_SECONDS: Joi.number().integer().min(1),
  FX_DISPLAY_MAXIMUM_RATE_AGE_SECONDS: Joi.number().integer().min(1),
  FX_PUBLICATION_GRACE_SECONDS: Joi.number().integer().min(0),
  FX_MAXIMUM_JUMP_RATIO: Joi.string()
    .pattern(/^0\.\d{1,6}$/)
    .default('0.20'),
  // JSON {currency: "0.35"} — per-currency jump thresholds replacing the global one.
  FX_JUMP_RATIO_OVERRIDES: Joi.string().default('{}'),
  // JSON {currency: {minimum, maximum}} of USD-based mids, decimal strings.
  FX_RATE_BOUNDS: Joi.string().default(
    '{"USD":{"minimum":"1","maximum":"1"},"NGN":{"minimum":"100","maximum":"100000"},"EUR":{"minimum":"0.1","maximum":"10"},"GBP":{"minimum":"0.1","maximum":"10"}}',
  ),
  FX_QUOTE_TIME_TO_LIVE_SECONDS: Joi.number().integer().min(5).max(300).default(30),
  FX_REQUEST_TIMEOUT_MILLISECONDS: Joi.number().integer().min(100).max(30_000).default(2000),
  FX_READ_RETRIES: Joi.number().integer().min(0).max(5).default(3),
  FX_POLL_INTERVAL_MILLISECONDS: Joi.number().integer().min(50).default(15_000),
  FX_LOCAL_CACHE_MILLISECONDS: Joi.number().integer().min(0).max(10_000).default(1000),
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
  const paystack = error ? undefined : parsePaystack(raw, env, problems);
  const funding = parseFunding(env.PSP_FUNDING_CURRENCIES, env.FUNDING_LIMITS, paystack?.enabled ? paystack.currencies : [], problems);
  const conversion = parseConversion(env.CONVERSION_LIMITS, problems);
  const fx = error ? undefined : parseFx(env, problems);
  const reconciliation = error ? undefined : parseReconciliation(env, funding?.currencies ?? [], problems);
  const buildGitSha = resolveBuildGitSha(env.BUILD_GIT_SHA, env.NODE_ENV === 'production', problems);
  if (problems.length > 0 || !keys || !pepper || !webhookSecrets || !funding || !conversion || !fx || !reconciliation || !paystack) {
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
      [RoundingPurpose.USER_DEBIT]: env.ROUNDING_USER_DEBIT,
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
    paystack,
    funding,
    conversion,
    flows: {
      pollIntervalMilliseconds: env.FLOW_POLL_INTERVAL_MILLISECONDS,
      batchSize: env.FLOW_BATCH_SIZE,
      leaseSeconds: env.FLOW_LEASE_SECONDS,
      maximumBackoffSeconds: env.FLOW_MAXIMUM_BACKOFF_SECONDS,
      stalledAfterMinutes: env.FLOW_STALLED_AFTER_MINUTES,
      webhookMaxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
      reservationSweepIntervalMilliseconds: env.RESERVATION_SWEEP_INTERVAL_MILLISECONDS,
    },
    fx,
    reconciliation,
    admin: {
      approvalTimeToLiveHours: env.APPROVAL_TTL_HOURS,
      breakGlassReviewHours: env.BREAK_GLASS_REVIEW_HOURS,
      manualRateMaximumValiditySeconds: env.MANUAL_RATE_MAXIMUM_VALIDITY_SECONDS,
      breakGlassManualRateMaximumValiditySeconds: env.BREAK_GLASS_MANUAL_RATE_MAXIMUM_VALIDITY_SECONDS,
      monitorTickMilliseconds: env.ADMIN_MONITOR_TICK_MILLISECONDS,
      buildGitSha: buildGitSha as string,
    },
    trustProxyHops: env.TRUST_PROXY_HOPS,
    apiDocsEnabled: env.API_DOCS_ENABLED ?? env.NODE_ENV !== 'production',
  };
}

/** Written by `npm run build` (`scripts/stamp-build.js`) next to the compiled code: `dist/build-info.json`. */
export const BUILD_INFO_PATH = join(__dirname, '..', 'build-info.json');

/**
 * The running version (design §9.4: "the build stamps a git SHA into /health"): `BUILD_GIT_SHA` (CI) wins, else
 * the file the build wrote. No runtime git. Production refuses to boot without one; elsewhere it is `unknown`.
 */
export function resolveBuildGitSha(fromEnvironment: string | undefined, production: boolean, problems: string[]): string {
  if (fromEnvironment) return fromEnvironment;
  if (existsSync(BUILD_INFO_PATH)) {
    try {
      const { gitSha } = JSON.parse(readFileSync(BUILD_INFO_PATH, 'utf8')) as { gitSha?: unknown };
      if (typeof gitSha === 'string' && /^[0-9a-f]{7,40}$/.test(gitSha)) return gitSha;
    } catch {
      // reported below
    }
    problems.push(`${BUILD_INFO_PATH} does not hold a git SHA`);
    return 'unknown';
  }
  if (production) problems.push('BUILD_GIT_SHA (or dist/build-info.json from `npm run build`) is required in production');
  return 'unknown';
}

const API_KEY_PLACEHOLDER = '{apiKey}';
const DECIMAL_PATTERN = /^(0|[1-9]\d*)(\.\d+)?$/;
const JUMP_RATIO_PATTERN = /^0\.\d{1,6}$/;

function parseJsonObject(name: string, value: string, problems: string[]): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // reported below
  }
  problems.push(`${name} must be a JSON object`);
  return undefined;
}

/**
 * FX provider settings (Phase 6). The plan fixes the defaults (cadence, budgets, freshness
 * windows); each can be overridden. Refused: a key without an `{apiKey}` URL or the reverse,
 * a display window shorter than the executable one, bounds that are not decimal strings,
 * and — in production — a plan whose rates are too old to trade on (Phase 6 §5.2) or a
 * plain-HTTP provider.
 */
function parseFx(env: Record<string, never>, problems: string[]): FxConfig | undefined {
  const before = problems.length;
  const plan = env.FX_PROVIDER_PLAN as ProviderPlan;
  const profile = PROVIDER_PLAN_PROFILES[plan];
  const baseUrl = String(env.FX_RATE_BASE_URL).replace(/\/+$/, '');
  const apiKey = env.EXCHANGE_RATE_API_KEY as string | undefined;
  const needsKey = baseUrl.includes(API_KEY_PLACEHOLDER);
  try {
    const url = new URL(baseUrl.split(API_KEY_PLACEHOLDER).join('key'));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme');
  } catch {
    problems.push('FX_RATE_BASE_URL must be an http(s) URL (optionally with an {apiKey} path placeholder)');
  }
  if (needsKey && !apiKey) problems.push(`EXCHANGE_RATE_API_KEY is required: FX_RATE_BASE_URL contains ${API_KEY_PLACEHOLDER}`);
  if (!needsKey && apiKey) problems.push(`EXCHANGE_RATE_API_KEY is set but FX_RATE_BASE_URL has no ${API_KEY_PLACEHOLDER} placeholder to carry it`);
  if (plan === ProviderPlan.OPEN && needsKey) problems.push('FX_PROVIDER_PLAN=OPEN is the key-less endpoint; a keyed URL needs FREE, PRO or BUSINESS');
  if (plan !== ProviderPlan.OPEN && !needsKey) problems.push(`FX_PROVIDER_PLAN=${plan} is a keyed plan; FX_RATE_BASE_URL needs ${API_KEY_PLACEHOLDER}`);
  if (env.NODE_ENV === 'production') {
    if (!profile.allowedInProduction) {
      problems.push(`FX_PROVIDER_PLAN=${plan} publishes once a day: too old to trade on, refused in production (Phase 6 §5.2)`);
    }
    if (!baseUrl.startsWith('https://')) problems.push('FX_RATE_BASE_URL must be https in production');
  }

  const executableMaximumAgeSeconds = (env.FX_EXECUTABLE_MAXIMUM_RATE_AGE_SECONDS as number | undefined) ?? profile.executableMaximumAgeSeconds;
  const displayMaximumAgeSeconds = (env.FX_DISPLAY_MAXIMUM_RATE_AGE_SECONDS as number | undefined) ?? profile.displayMaximumAgeSeconds;
  if (displayMaximumAgeSeconds < executableMaximumAgeSeconds) {
    problems.push('FX_DISPLAY_MAXIMUM_RATE_AGE_SECONDS must be at least the executable maximum age');
  }

  const overrides = new Map<string, string>();
  const rawOverrides = parseJsonObject('FX_JUMP_RATIO_OVERRIDES', env.FX_JUMP_RATIO_OVERRIDES, problems) ?? {};
  for (const [currency, ratio] of Object.entries(rawOverrides)) {
    if (!/^[A-Z]{3}$/.test(currency) || typeof ratio !== 'string' || !JUMP_RATIO_PATTERN.test(ratio)) {
      problems.push(`FX_JUMP_RATIO_OVERRIDES.${currency} must be a ratio string such as "0.35"`);
      continue;
    }
    overrides.set(currency, ratio);
  }

  const bounds = new Map<string, FxRateBounds>();
  const rawBounds = parseJsonObject('FX_RATE_BOUNDS', env.FX_RATE_BOUNDS, problems) ?? {};
  for (const [currency, entry] of Object.entries(rawBounds)) {
    const { minimum, maximum } = (entry ?? {}) as { minimum?: unknown; maximum?: unknown };
    if (
      !/^[A-Z]{3}$/.test(currency) || typeof minimum !== 'string' || typeof maximum !== 'string' ||
      !DECIMAL_PATTERN.test(minimum) || !DECIMAL_PATTERN.test(maximum) || /^0(\.0*)?$/.test(minimum)
    ) {
      problems.push(`FX_RATE_BOUNDS.${currency} needs positive decimal strings {minimum, maximum}`);
      continue;
    }
    bounds.set(currency, { minimum, maximum });
  }
  if (problems.length > before) return undefined;
  return {
    providerName: env.FX_PROVIDER_NAME,
    baseUrl,
    apiKey,
    plan,
    cadenceSeconds: profile.cadenceSeconds,
    monthlyRequestBudget: (env.FX_MONTHLY_REQUEST_BUDGET as number | undefined) ?? profile.monthlyBudget,
    dailyRequestBudget: (env.FX_DAILY_REQUEST_BUDGET as number | undefined) ?? profile.dailyBudget,
    executableMaximumAgeSeconds,
    displayMaximumAgeSeconds,
    publicationGraceSeconds: (env.FX_PUBLICATION_GRACE_SECONDS as number | undefined) ?? profile.publicationGraceSeconds,
    latePublicationRetrySeconds: profile.latePublicationRetrySeconds,
    maximumJumpRatio: env.FX_MAXIMUM_JUMP_RATIO,
    jumpRatioOverrides: overrides,
    rateBounds: bounds,
    quoteTimeToLiveSeconds: env.FX_QUOTE_TIME_TO_LIVE_SECONDS,
    requestTimeoutMilliseconds: env.FX_REQUEST_TIMEOUT_MILLISECONDS,
    readRetries: env.FX_READ_RETRIES,
    pollIntervalMilliseconds: env.FX_POLL_INTERVAL_MILLISECONDS,
    localCacheMilliseconds: env.FX_LOCAL_CACHE_MILLISECONDS,
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

/**
 * Paystack settings. Refused: enabled without a key or a callback URL; a live key outside production, a test key in
 * production (no fall-through "try the other key"); `PSP_NAME=paystack` (two providers under one name); the old
 * `PAYSTACK_WEBHOOK_URL` (renamed: it was the browser's callback — Paystack's webhook URL is set in its dashboard).
 */
function parsePaystack(raw: Record<string, string | undefined>, env: Record<string, never>, problems: string[]): PaystackConfig | undefined {
  const before = problems.length;
  const enabled = env.PAYSTACK_ENABLED as boolean;
  const secretKey = (env.PAYSTACK_SECRET_KEY as string | undefined) ?? '';
  const callbackUrl = (env.PAYSTACK_CALLBACK_URL as string | undefined) ?? '';
  const production = env.NODE_ENV === 'production';
  if (raw.PAYSTACK_WEBHOOK_URL !== undefined) {
    problems.push(
      'PAYSTACK_WEBHOOK_URL was renamed PAYSTACK_CALLBACK_URL (where the customer\'s browser returns); ' +
        'Paystack\'s webhook URL is set in the Paystack dashboard, not here',
    );
  }
  if (env.PSP_NAME === PAYSTACK_PROVIDER_NAME) problems.push('PSP_NAME must not be "paystack": that name belongs to the Paystack provider');
  if (secretKey) {
    if (production && secretKey.startsWith('sk_test_')) problems.push('PAYSTACK_SECRET_KEY is a test key (sk_test_): refused in production');
    if (!production && secretKey.startsWith('sk_live_')) problems.push('PAYSTACK_SECRET_KEY is a live key (sk_live_): refused outside production');
  }
  if (enabled) {
    if (!secretKey) problems.push('PAYSTACK_SECRET_KEY is required when PAYSTACK_ENABLED=true');
    if (!callbackUrl) problems.push('PAYSTACK_CALLBACK_URL is required when PAYSTACK_ENABLED=true');
    if (production && callbackUrl && !callbackUrl.startsWith('https://')) problems.push('PAYSTACK_CALLBACK_URL must be https in production');
    if (production && !String(env.PAYSTACK_BASE_URL).startsWith('https://')) problems.push('PAYSTACK_BASE_URL must be https in production');
  }
  if (problems.length > before) return undefined;
  const allowlist = env.PAYSTACK_WEBHOOK_IP_ALLOWLIST as string | undefined;
  return {
    enabled,
    name: PAYSTACK_PROVIDER_NAME,
    secretKey,
    baseUrl: String(env.PAYSTACK_BASE_URL).replace(/\/+$/, ''),
    callbackUrl,
    currencies: [...new Set(String(env.PAYSTACK_FUNDING_CURRENCIES).split(','))],
    checkoutWindowMinutes: env.PAYSTACK_CHECKOUT_WINDOW_MINUTES,
    webhookIpAllowlist: allowlist ? [...new Set(allowlist.split(','))] : null,
    requestTimeoutMilliseconds: env.PAYSTACK_REQUEST_TIMEOUT_MILLISECONDS,
    initializeTimeoutMilliseconds: env.PAYSTACK_INITIALIZE_TIMEOUT_MILLISECONDS,
    readRetries: env.PAYSTACK_READ_RETRIES,
  };
}

/**
 * Funding currencies and their bounds: strings of minor units, every currency covered, min ≤ max. One limit set for
 * every provider: `extraCurrencies` (Paystack's, when enabled) must have limits too.
 */
function parseFunding(
  currencyList: string | undefined,
  limitsJson: string | undefined,
  extraCurrencies: readonly string[],
  problems: string[],
): FundingConfig | undefined {
  if (!currencyList || !limitsJson) return undefined;
  const currencies = [...new Set(currencyList.split(','))];
  const limited = [...new Set([...currencies, ...extraCurrencies])];
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
  for (const currency of limited) {
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
  return limits.size === limited.length ? { currencies, limits } : undefined;
}

/** Conversion limits per source currency: strings of minor units, maximum ≤ daily maximum. */
function parseTimeOfDay(value: string): TimeOfDay {
  const [hour, minute] = value.split(':').map((part) => Number.parseInt(part, 10));
  return { hour, minute };
}

/**
 * Reconciliation settings (Phase 9). `SETTLEMENT_WINDOWS` is JSON per currency
 * (`{"NGN":{"businessDays":2,"graceHours":24}}`); every funding currency needs one, or an
 * unsettled deposit could never be told apart from an expected one (refused at boot).
 */
function parseReconciliation(
  env: Record<string, never>,
  fundingCurrencies: readonly string[],
  problems: string[],
): ReconciliationConfig | undefined {
  const before = problems.length;
  const windows = new Map<string, SettlementWindow>();
  const raw = parseJsonObject('SETTLEMENT_WINDOWS', env.SETTLEMENT_WINDOWS, problems) ?? {};
  for (const [currency, entry] of Object.entries(raw)) {
    const { businessDays, graceHours } = (entry ?? {}) as { businessDays?: unknown; graceHours?: unknown };
    if (
      !/^[A-Z]{3}$/.test(currency) ||
      !Number.isInteger(businessDays) || (businessDays as number) < 0 || (businessDays as number) > 30 ||
      !Number.isInteger(graceHours) || (graceHours as number) < 0 || (graceHours as number) > 24 * 30
    ) {
      problems.push(`SETTLEMENT_WINDOWS.${currency} needs integer {businessDays (0–30), graceHours (0–720)}`);
      continue;
    }
    windows.set(currency, { businessDays: businessDays as number, graceHours: graceHours as number });
  }
  for (const currency of fundingCurrencies) {
    if (!windows.has(currency)) problems.push(`SETTLEMENT_WINDOWS has no settlement window for funding currency ${currency}`);
  }
  if (problems.length > before) return undefined;
  return {
    enabled: env.RECONCILIATION_ENABLED,
    tickMilliseconds: env.RECONCILIATION_TICK_MILLISECONDS,
    internalAt: parseTimeOfDay(env.RECONCILIATION_INTERNAL_AT),
    externalDailyAt: parseTimeOfDay(env.RECONCILIATION_EXTERNAL_DAILY_AT),
    externalHourlyMinute: env.RECONCILIATION_EXTERNAL_HOURLY_MINUTE,
    leaseSeconds: env.RECONCILIATION_LEASE_SECONDS,
    statementTimeoutSeconds: env.RECONCILIATION_STATEMENT_TIMEOUT_SECONDS,
    lookbackDays: env.RECONCILIATION_LOOKBACK_DAYS,
    unresolvedFlowAgeMinutes: env.RECONCILIATION_UNRESOLVED_FLOW_AGE_MINUTES,
    settlementWindows: windows,
  };
}

function parseConversion(limitsJson: string | undefined, problems: string[]): ConversionConfig | undefined {
  if (!limitsJson) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(limitsJson);
  } catch {
    problems.push('CONVERSION_LIMITS must be JSON');
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    problems.push('CONVERSION_LIMITS must map currency to {maximum, dailyMaximum}');
    return undefined;
  }
  const limits = new Map<string, ConversionLimit>();
  let valid = true;
  for (const [currency, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const { maximum, dailyMaximum } = (entry ?? {}) as { maximum?: unknown; dailyMaximum?: unknown };
    if (
      !/^[A-Z]{3}$/.test(currency) ||
      typeof maximum !== 'string' || typeof dailyMaximum !== 'string' ||
      !MINOR_UNITS_PATTERN.test(maximum) || !MINOR_UNITS_PATTERN.test(dailyMaximum)
    ) {
      problems.push(`CONVERSION_LIMITS.${currency} needs maximum and dailyMaximum as positive strings of minor units`);
      valid = false;
      continue;
    }
    if (BigInt(maximum) > BigInt(dailyMaximum)) {
      problems.push(`CONVERSION_LIMITS.${currency}: maximum exceeds dailyMaximum`);
      valid = false;
      continue;
    }
    limits.set(currency, { maximumMinor: BigInt(maximum), dailyMaximumMinor: BigInt(dailyMaximum) });
  }
  return valid ? { limits } : undefined;
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
