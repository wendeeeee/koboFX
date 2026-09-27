import { RoundingPurpose, RoundingStrategy } from '../common/money/rounding-policy';
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
  ROUNDING_REVENUE: 'ROUND_HALF_EVEN',
  ROUNDING_FEE: 'ROUND_HALF_EVEN',
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
      [RoundingPurpose.REVENUE]: RoundingStrategy.ROUND_HALF_EVEN,
      [RoundingPurpose.FEE]: RoundingStrategy.ROUND_HALF_EVEN,
    });
  });

  it('fails fast and reports EVERY problem at once', () => {
    const problems = problemsOf({ NODE_ENV: 'test' });
    for (const key of ['DB_HOST', 'DB_NAME', 'DB_APP_USER', 'REDIS_URL', 'ROUNDING_USER_CREDIT']) {
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
});
