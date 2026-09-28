import { createHash } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { normalizeEmailAddress } from '../../modules/users/email-address';
import { RateLimitCounter, RateLimiter } from '../../redis/rate-limiter';
import { RATE_LIMIT_KEY, RateLimitPolicy, RateLimitRule, SKIP_RATE_LIMIT_KEY } from '../decorators/rate-limit.decorator';
import { DependencyUnavailableError, RateLimitedError } from '../errors';

/** design §9.1: 100 requests per minute per IP, on every route. */
export const GLOBAL_RATE_LIMIT_RULE: RateLimitRule = { name: 'global', subject: 'ip', limit: 100, windowSeconds: 60 };

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Counter keys never hold personal data in the clear: the subject is hashed. */
export function rateLimitCounters(rules: readonly RateLimitRule[], request: Request): RateLimitCounter[] {
  const ip = request.ip ?? 'unknown';
  const body = request.body as { email?: unknown } | undefined;
  const email = typeof body?.email === 'string' ? normalizeEmailAddress(body.email) : '';
  return rules.map((rule) => {
    const subject = rule.subject === 'ip' ? ip : rule.subject === 'email' ? email : `${ip}|${email}`;
    return {
      key: `rate-limit:${rule.name}:${rule.subject}:${hash(subject)}`,
      limit: rule.limit,
      windowSeconds: rule.windowSeconds,
    };
  });
}

/**
 * The first guard (it runs before authentication, so token guessing is throttled
 * too). Applies the global per-IP rule plus the route's `@RateLimit()` rules; `429`
 * with `Retry-After` when any is exceeded.
 *
 * Redis down: the route's policy decides (decision #10) — fail closed with `503` on
 * credential-checking and email-sending routes, fail open (logged) elsewhere.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT_KEY, targets)) return true;
    const policy = this.reflector.getAllAndOverride<RateLimitPolicy | undefined>(RATE_LIMIT_KEY, targets);
    const request = context.switchToHttp().getRequest<Request>();
    const counters = rateLimitCounters([GLOBAL_RATE_LIMIT_RULE, ...(policy?.rules ?? [])], request);

    let decision;
    try {
      decision = await this.rateLimiter.consume(counters);
    } catch (error) {
      if (!(error instanceof DependencyUnavailableError) || policy?.whenUnavailable === 'fail-closed') throw error;
      this.logger.warn({ path: request.path }, 'Rate limiter unavailable; failing open for this route');
      return true;
    }
    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);
    return true;
  }
}
