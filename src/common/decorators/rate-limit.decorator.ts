import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rateLimit:policy';
export const SKIP_RATE_LIMIT_KEY = 'rateLimit:skip';

/**
 * What a counter is keyed by. Emails are hashed before they reach Redis. `user` is the
 * AUTHENTICATED caller's id: those rules run in `UserRateLimitGuard`, after authentication (the
 * first guard runs before it, when the only trustworthy subject is the IP).
 */
export type RateLimitSubject = 'ip' | 'email' | 'ip-and-email' | 'user';

export interface RateLimitRule {
  /** Counter name. Rules with the same name share a counter across routes. */
  readonly name: string;
  readonly subject: RateLimitSubject;
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * - `fail-closed`: Redis down ⇒ 503. For routes that check credentials or send email.
 * - `fail-open`: Redis down ⇒ allowed, logged. For routes already behind a credential
 *   that cannot be brute-forced (decision #10).
 */
export type RateLimitFailureMode = 'fail-closed' | 'fail-open';

export interface RateLimitPolicy {
  readonly rules: readonly RateLimitRule[];
  readonly whenUnavailable: RateLimitFailureMode;
  /**
   * The route's rules REPLACE the global per-IP rule instead of adding to it. Only for a
   * machine caller whose legitimate volume exceeds a person's (the PSP's webhooks).
   */
  readonly replacesGlobalRule?: boolean;
}

/** Route-specific limits, applied on top of the global per-IP limit. */
export const RateLimit = (policy: RateLimitPolicy): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_KEY, policy);

/** Exempt a route from rate limiting entirely (health probes). */
export const SkipRateLimit = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_RATE_LIMIT_KEY, true);
