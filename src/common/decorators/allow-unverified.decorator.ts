import { SetMetadata } from '@nestjs/common';

export const ALLOW_UNVERIFIED_KEY = 'authentication:allowUnverified';

/**
 * Authenticated, but not necessarily ACTIVE (verified and not suspended). Everything
 * else requires an ACTIVE user (`VerifiedUserGuard` is global): logout must work for a
 * suspended user; trading must not.
 */
export const AllowUnverified = (): MethodDecorator & ClassDecorator => SetMetadata(ALLOW_UNVERIFIED_KEY, true);
