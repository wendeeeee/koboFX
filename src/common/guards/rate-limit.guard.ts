import { createHash } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { normalizeEmailAddress } from '../../modules/users/email-address';
import { RateLimitCounter, RateLimiter } from '../../redis/rate-limiter';
import { RATE_LIMIT_KEY, RateLimitPolicy, RateLimitRule, SKIP_RATE_LIMIT_KEY } from '../decorators/rate-limit.decorator';
import { DependencyUnavailableError, InvariantViolationError, RateLimitedError } from '../errors';
import { AuthenticatedRequest } from './authenticated-request';

/** design §9.1: 100 requests per minute per IP, on every route. */
export const GLOBAL_RATE_LIMIT_RULE: RateLimitRule = { name: 'global', subject: 'ip', limit: 100, windowSeconds: 60 };

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Counter keys never hold personal data in the clear: the subject is hashed. */
export function rateLimitCounters(rules: readonly RateLimitRule[], request: Request): RateLimitCounter[] {
  const ip = request.ip ?? 'unknown';
  const body = request.body as { email?: unknown } | undefined;
  const email = typeof body?.email === 'string' ? normalizeEmailAddress(body.email) : '';
  return rules.map((rule) => {
    const subject = rule.subject === 'user' ? authenticatedUserId(request) : rule.subject === 'ip' ? ip : rule.subject === 'email' ? email : `${ip}|${email}`;
    return {
      key: `rate-limit:${rule.name}:${rule.subject}:${hash(subject)}`,
      limit: rule.limit,
      windowSeconds: rule.windowSeconds,
    };
  });
}

/** A `user` rule on a route nobody authenticated for is a configuration bug: fail loudly. */
function authenticatedUserId(request: Request): string {
  const user = (request as AuthenticatedRequest).user;
  if (!user) throw new InvariantViolationError('A per-user rate limit applies to a route without an authenticated user.', { path: request.path });
  return user.id;
}

/** Consume the counters; Redis down ⇒ the route's policy decides. Shared by both rate-limit guards. */
async function enforce(
  rateLimiter: RateLimiter,
  logger: Logger,
  counters: RateLimitCounter[],
  policy: RateLimitPolicy | undefined,
  request: Request,
): Promise<true> {
  let decision;
  try {
    decision = await rateLimiter.consume(counters);
  } catch (error) {
    if (!(error instanceof DependencyUnavailableError) || policy?.whenUnavailable === 'fail-closed') throw error;
    logger.warn({ path: request.path }, 'Rate limiter unavailable; failing open for this route');
    return true;
  }
  if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);
  return true;
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
    // Per-user rules wait for UserRateLimitGuard: no user is authenticated yet.
    const routeRules = (policy?.rules ?? []).filter((rule) => rule.subject !== 'user');
    const rules = policy?.replacesGlobalRule ? routeRules : [GLOBAL_RATE_LIMIT_RULE, ...routeRules];
    return enforce(this.rateLimiter, this.logger, rateLimitCounters(rules, request), policy, request);
  }
}

/**
 * The LAST guard (after authentication and the verified-user check): the route's `user` rules,
 * keyed by the authenticated caller's id — never by an unverified token claim, which would let
 * anyone spend another user's budget. Same limiter, same failure policy as `RateLimitGuard`.
 */
@Injectable()
export class UserRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(UserRateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT_KEY, targets)) return true;
    const policy = this.reflector.getAllAndOverride<RateLimitPolicy | undefined>(RATE_LIMIT_KEY, targets);
    const rules = (policy?.rules ?? []).filter((rule) => rule.subject === 'user');
    if (rules.length === 0) return true;
    const request = context.switchToHttp().getRequest<Request>();
    return enforce(this.rateLimiter, this.logger, rateLimitCounters(rules, request), policy, request);
  }
}
