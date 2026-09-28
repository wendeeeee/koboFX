import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RateLimiter } from '../../redis/rate-limiter';
import { RedisService } from '../../redis/redis.service';
import { RATE_LIMIT_KEY, RateLimitPolicy, SKIP_RATE_LIMIT_KEY } from '../decorators/rate-limit.decorator';
import { DependencyUnavailableError, RateLimitedError } from '../errors';
import { GLOBAL_RATE_LIMIT_RULE, RateLimitGuard, rateLimitCounters } from './rate-limit.guard';

function contextFor(request: Partial<Request>, metadata: Record<string, unknown> = {}) {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => metadata[key as string]);
  const context = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, reflector };
}

const closed: RateLimitPolicy = {
  rules: [{ name: 'login', subject: 'ip-and-email', limit: 5, windowSeconds: 900 }],
  whenUnavailable: 'fail-closed',
};
const open: RateLimitPolicy = { rules: [], whenUnavailable: 'fail-open' };

describe('RateLimitGuard (design §9.1, decision #10)', () => {
  const limiter = { consume: jest.fn() } as unknown as jest.Mocked<RateLimiter>;
  beforeEach(() => jest.resetAllMocks());

  it('always applies the global per-IP rule, plus the route rules', async () => {
    limiter.consume.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    const { context, reflector } = contextFor({ ip: '10.0.0.1', body: { email: 'A@Example.com' } }, { [RATE_LIMIT_KEY]: closed });
    await expect(new RateLimitGuard(reflector, limiter).canActivate(context)).resolves.toBe(true);
    const counters = limiter.consume.mock.calls[0][0];
    expect(counters.map((counter) => [counter.limit, counter.windowSeconds])).toEqual([
      [GLOBAL_RATE_LIMIT_RULE.limit, 60],
      [5, 900],
    ]);
  });

  it('refuses with 429 and a Retry-After when a counter is exceeded', async () => {
    limiter.consume.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    const { context, reflector } = contextFor({ ip: '10.0.0.1' });
    const error = await new RateLimitGuard(reflector, limiter).canActivate(context).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAfterSeconds).toBe(42);
  });

  it('Redis down: fails closed (503) on a fail-closed route, open on others', async () => {
    limiter.consume.mockRejectedValue(new DependencyUnavailableError('down'));
    const closedRoute = contextFor({ ip: '10.0.0.1', path: '/login' }, { [RATE_LIMIT_KEY]: closed });
    await expect(new RateLimitGuard(closedRoute.reflector, limiter).canActivate(closedRoute.context)).rejects.toThrow(
      DependencyUnavailableError,
    );
    for (const metadata of [{ [RATE_LIMIT_KEY]: open }, {}]) {
      const route = contextFor({ ip: '10.0.0.1', path: '/x' }, metadata);
      await expect(new RateLimitGuard(route.reflector, limiter).canActivate(route.context)).resolves.toBe(true);
    }
  });

  it('never swallows a non-availability error', async () => {
    limiter.consume.mockRejectedValue(new TypeError('bug'));
    const { context, reflector } = contextFor({ ip: '10.0.0.1' }, { [RATE_LIMIT_KEY]: open });
    await expect(new RateLimitGuard(reflector, limiter).canActivate(context)).rejects.toThrow(TypeError);
  });

  it('skips @SkipRateLimit() routes entirely', async () => {
    const { context, reflector } = contextFor({ ip: '10.0.0.1' }, { [SKIP_RATE_LIMIT_KEY]: true });
    await expect(new RateLimitGuard(reflector, limiter).canActivate(context)).resolves.toBe(true);
    expect(limiter.consume).not.toHaveBeenCalled();
  });

  it('keys counters by hashed subject: no email or IP in clear, and email casing does not escape the limit', () => {
    const rules = [{ name: 'login', subject: 'ip-and-email' as const, limit: 5, windowSeconds: 900 }];
    const [lower] = rateLimitCounters(rules, { ip: '10.0.0.1', body: { email: 'user@example.com' } } as Request);
    const [upper] = rateLimitCounters(rules, { ip: '10.0.0.1', body: { email: '  USER@Example.COM ' } } as Request);
    const [otherIp] = rateLimitCounters(rules, { ip: '10.0.0.2', body: { email: 'user@example.com' } } as Request);
    expect(lower.key).toBe(upper.key);
    expect(lower.key).not.toBe(otherIp.key);
    expect(lower.key).toMatch(/^rate-limit:login:ip-and-email:[0-9a-f]{64}$/);
    expect(lower.key).not.toContain('example');
  });
});

describe('RateLimiter', () => {
  const redis = { evaluate: jest.fn() } as unknown as jest.Mocked<RedisService>;
  const limiter = new RateLimiter(redis);
  const counters = [
    { key: 'a', limit: 100, windowSeconds: 60 },
    { key: 'b', limit: 5, windowSeconds: 900 },
  ];

  it('allows while every counter is within its limit (and sends windows in milliseconds)', async () => {
    redis.evaluate.mockResolvedValue([1, 60_000, 5, 899_000]);
    await expect(limiter.consume(counters)).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(redis.evaluate.mock.calls[0][2]).toEqual([60_000, 900_000]);
  });

  it('refuses when any counter is over, reporting the longest wait in whole seconds', async () => {
    redis.evaluate.mockResolvedValue([101, 30_500, 6, 120_001]);
    await expect(limiter.consume(counters)).resolves.toEqual({ allowed: false, retryAfterSeconds: 121 });
  });

  it('never reports a zero Retry-After', async () => {
    redis.evaluate.mockResolvedValue([101, 1, 1, 1]);
    await expect(limiter.consume(counters)).resolves.toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('with no counters, does not touch Redis', async () => {
    redis.evaluate.mockClear();
    await expect(limiter.consume([])).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(redis.evaluate).not.toHaveBeenCalled();
  });
});
