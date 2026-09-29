import { RoundingPurpose, RoundingStrategy } from '../common/money/rounding-policy';
import { KeyObject, generateKeyPairSync } from 'node:crypto';
import { authenticationTestEnvironment, testKeyPair } from '../../test/support/authentication-secrets';
import { ConfigValidationError, loadConfig } from './configuration';

const VALID = {
  NODE_ENV: 'test',
  DB_HOST: 'localhost',
  DB_NAME: 'kobofx',
  DB_APP_USER: 'fx_app',
  DB_APP_PASSWORD: 'a',
  DB_MIGRATION_USER: 'fx_owner',
  DB_MIGRATION_PASSWORD: 'b',
  REDIS_URL: 'redis://localhost:6379',
  ROUNDING_USER_CREDIT: 'ROUND_DOWN',
  ROUNDING_USER_DEBIT: 'ROUND_UP',
  ROUNDING_REVENUE: 'ROUND_HALF_EVEN',
  ROUNDING_FEE: 'ROUND_HALF_EVEN',
  ...authenticationTestEnvironment(),
};

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigValidationError) return error.problems;
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('builds typed config with the design defaults (§6.6 timeouts)', () => {
    const config = loadConfig(VALID);
    expect(config.port).toBe(3000);
    expect(config.db.port).toBe(5432);
    expect(config.db.lockTimeoutMs).toBe(3000);
    expect(config.db.statementTimeoutMs).toBe(10_000);
    expect(config.db.app).toEqual({ user: 'fx_app', password: 'a' });
    expect(config.rounding).toEqual({
      [RoundingPurpose.USER_CREDIT]: RoundingStrategy.ROUND_DOWN,
      [RoundingPurpose.USER_DEBIT]: RoundingStrategy.ROUND_UP,
      [RoundingPurpose.REVENUE]: RoundingStrategy.ROUND_HALF_EVEN,
      [RoundingPurpose.FEE]: RoundingStrategy.ROUND_HALF_EVEN,
    });
  });

  it('defaults the ledger to 64 internal account buckets (design §6.6) and bounds it to SMALLINT use', () => {
    expect(loadConfig(VALID).ledger.internalAccountBuckets).toBe(64);
    expect(loadConfig({ ...VALID, LEDGER_INTERNAL_BUCKETS: '8' }).ledger.internalAccountBuckets).toBe(8);
    expect(problemsOf({ ...VALID, LEDGER_INTERNAL_BUCKETS: '0' }).join()).toContain('LEDGER_INTERNAL_BUCKETS');
    expect(problemsOf({ ...VALID, LEDGER_INTERNAL_BUCKETS: '1025' }).join()).toContain('LEDGER_INTERNAL_BUCKETS');
  });

  it('fails fast and reports EVERY problem at once', () => {
    const problems = problemsOf({ NODE_ENV: 'test' });
    for (const key of ['DB_HOST', 'DB_NAME', 'DB_APP_USER', 'REDIS_URL', 'ROUNDING_USER_CREDIT', 'ROUNDING_USER_DEBIT']) {
      expect(problems.some((p) => p.includes(key))).toBe(true);
    }
  });

  it('has no default for rounding: a business decision is never silently filled in', () => {
    const { ROUNDING_REVENUE: _omitted, ...withoutRevenue } = VALID;
    expect(problemsOf(withoutRevenue).join()).toContain('ROUNDING_REVENUE');
  });

  it('rejects an unknown rounding strategy', () => {
    expect(problemsOf({ ...VALID, ROUNDING_USER_CREDIT: 'ROUND_NEAREST' }).join()).toContain(
      'ROUNDING_USER_CREDIT',
    );
  });

  it('refuses to run the app as the schema owner', () => {
    expect(problemsOf({ ...VALID, DB_APP_USER: 'fx_owner' }).join()).toContain(
      'DB_APP_USER must differ from DB_MIGRATION_USER',
    );
  });

  it('rejects malformed values', () => {
    expect(problemsOf({ ...VALID, PORT: 'eighty' }).join()).toContain('PORT');
    expect(problemsOf({ ...VALID, REDIS_URL: 'http://x' }).join()).toContain('REDIS_URL');
    expect(problemsOf({ ...VALID, NODE_ENV: 'staging' }).join()).toContain('NODE_ENV');
  });

  describe('authentication settings (design §9.1)', () => {
    it('builds typed key material, TTLs and the pepper; demo credit defaults to off', () => {
      const config = loadConfig(VALID).authentication;
      expect(config.accessToken.signingKeyId).toBe('test-key-1');
      expect(config.accessToken.publicKeys.has('test-key-1')).toBe(true);
      expect(config.accessToken.timeToLiveSeconds).toBe(900);
      expect(config.refreshTokenTimeToLiveSeconds).toBe(7 * 24 * 3600);
      expect(config.oneTimePasswordPepper.length).toBeGreaterThanOrEqual(32);
      expect(config.demoCreditNgnMinor).toBe(0n);
      expect(loadConfig({ ...VALID, DEMO_CREDIT_NGN_MINOR: '10000000' }).authentication.demoCreditNgnMinor).toBe(10_000_000n);
    });

    it('has no defaults for secrets: each missing one is reported', () => {
      const problems = problemsOf({
        ...VALID,
        JWT_SIGNING_KEY_ID: undefined,
        JWT_PRIVATE_KEY: undefined,
        JWT_PUBLIC_KEYS: undefined,
        ONE_TIME_PASSWORD_PEPPER: undefined,
        SMTP_HOST: undefined,
        MAIL_FROM: undefined,
      }).join('\n');
      for (const name of ['JWT_SIGNING_KEY_ID', 'JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEYS', 'ONE_TIME_PASSWORD_PEPPER', 'SMTP_HOST', 'MAIL_FROM']) {
        expect(problems).toContain(name);
      }
    });

    it('refuses a short pepper, a demo credit in production, and a float demo credit', () => {
      expect(problemsOf({ ...VALID, ONE_TIME_PASSWORD_PEPPER: Buffer.alloc(16).toString('base64') }).join()).toContain(
        'at least 32 bytes',
      );
      expect(problemsOf({ ...VALID, NODE_ENV: 'production', DEMO_CREDIT_NGN_MINOR: '100' }).join()).toContain(
        'DEMO_CREDIT_NGN_MINOR must be 0 in production',
      );
      expect(() => loadConfig({ ...VALID, NODE_ENV: 'production', DEMO_CREDIT_NGN_MINOR: '0' })).not.toThrow();
      expect(problemsOf({ ...VALID, DEMO_CREDIT_NGN_MINOR: '100.5' }).join()).toContain('DEMO_CREDIT_NGN_MINOR');
    });

    it('refuses key material that cannot work: mismatched pair, unknown signing key, weak or non-RSA keys', () => {
      const other = testKeyPair('other-key');
      const b64 = (text: string) => Buffer.from(text).toString('base64');
      expect(problemsOf({ ...VALID, JWT_PRIVATE_KEY: b64(other.privateKeyPem) }).join()).toContain('does not match');
      expect(problemsOf({ ...VALID, JWT_SIGNING_KEY_ID: 'nope' }).join()).toContain('must name a key in JWT_PUBLIC_KEYS');
      expect(problemsOf({ ...VALID, JWT_PRIVATE_KEY: b64('not a pem') }).join()).toContain('JWT_PRIVATE_KEY is not a valid');
      expect(problemsOf({ ...VALID, JWT_PUBLIC_KEYS: b64('[1,2]') }).join()).toContain('JWT_PUBLIC_KEYS must be');
      expect(problemsOf({ ...VALID, JWT_PUBLIC_KEYS: b64(JSON.stringify({ 'test-key-1': 'nope' })) }).join()).toContain(
        'is not a valid PEM public key',
      );
      const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
      const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const pem = (key: KeyObject, type: 'pkcs8' | 'spki') => key.export({ type, format: 'pem' }).toString();
      for (const pair of [weak, ec]) {
        const problems = problemsOf({
          ...VALID,
          JWT_PRIVATE_KEY: b64(pem(pair.privateKey, 'pkcs8')),
          JWT_PUBLIC_KEYS: b64(JSON.stringify({ 'test-key-1': pem(pair.publicKey, 'spki') })),
        }).join();
        expect(problems).toContain('must be an RSA key of at least 2048 bits');
      }
    });

    it('requires SMTP credentials in pairs', () => {
      expect(problemsOf({ ...VALID, SMTP_USER: 'u' }).join()).toContain('SMTP_PASSWORD');
      expect(loadConfig({ ...VALID, SMTP_USER: 'u', SMTP_PASSWORD: 'p' }).mail.smtp).toMatchObject({ user: 'u', password: 'p' });
    });
  });
});

describe('loadConfig: payment provider, funding and flows (Phase 5)', () => {
  it('builds the PSP, funding and flow settings with their defaults', () => {
    const config = loadConfig(VALID);
    expect(config.paymentProvider).toMatchObject({
      name: 'simulated-psp',
      webhookToleranceSeconds: 300,
      requestTimeoutMilliseconds: 2000,
      readRetries: 3,
    });
    expect(config.paymentProvider.webhookSecrets).toHaveLength(1);
    expect(config.paymentProvider.webhookSecrets[0].length).toBe(32);
    expect(config.funding.currencies).toEqual(['NGN']);
    expect(config.funding.limits.get('NGN')).toEqual({ minimumMinor: 10_000n, maximumMinor: 100_000_000n });
    expect(config.flows).toMatchObject({ leaseSeconds: 60, stalledAfterMinutes: 30, maximumBackoffSeconds: 900, webhookMaxAttempts: 10 });
  });

  it('has no defaults for PSP secrets', () => {
    const problems = problemsOf({ ...VALID, PSP_BASE_URL: undefined, PSP_SECRET_KEY: undefined, PSP_WEBHOOK_SECRETS: undefined });
    expect(problems.join('\n')).toMatch(/PSP_BASE_URL/);
    expect(problems.join('\n')).toMatch(/PSP_SECRET_KEY/);
    expect(problems.join('\n')).toMatch(/PSP_WEBHOOK_SECRETS/);
  });

  it('refuses short or too many webhook secrets, and a short API key', () => {
    const short = Buffer.alloc(16, 1).toString('base64');
    const good = Buffer.alloc(32, 2).toString('base64');
    expect(problemsOf({ ...VALID, PSP_WEBHOOK_SECRETS: short }).join()).toMatch(/at least 32 bytes/);
    expect(problemsOf({ ...VALID, PSP_WEBHOOK_SECRETS: 'not base64 !!' }).join()).toMatch(/at least 32 bytes/);
    expect(problemsOf({ ...VALID, PSP_WEBHOOK_SECRETS: [good, good, good].join(',') }).join()).toMatch(/at most two/);
    expect(loadConfig({ ...VALID, PSP_WEBHOOK_SECRETS: `${good},${good}` }).paymentProvider.webhookSecrets).toHaveLength(2);
    expect(problemsOf({ ...VALID, PSP_SECRET_KEY: 'short' }).join()).toMatch(/PSP_SECRET_KEY/);
  });

  it('requires limits for every funding currency, as strings of minor units, minimum ≤ maximum', () => {
    expect(problemsOf({ ...VALID, PSP_FUNDING_CURRENCIES: 'NGN,USD' }).join()).toMatch(/FUNDING_LIMITS.USD/);
    expect(problemsOf({ ...VALID, FUNDING_LIMITS: '{"NGN":{"minimum":100,"maximum":"200"}}' }).join()).toMatch(/strings of minor units/);
    expect(problemsOf({ ...VALID, FUNDING_LIMITS: '{"NGN":{"minimum":"300","maximum":"200"}}' }).join()).toMatch(/minimum exceeds maximum/);
    expect(problemsOf({ ...VALID, FUNDING_LIMITS: 'nope' }).join()).toMatch(/must be JSON/);
    expect(problemsOf({ ...VALID, FUNDING_LIMITS: '[]' }).join()).toMatch(/must map currency/);
    expect(problemsOf({ ...VALID, PSP_FUNDING_CURRENCIES: 'ngn' }).join()).toMatch(/PSP_FUNDING_CURRENCIES/);
  });
});
