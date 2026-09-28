import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'authentication:isPublic';

/**
 * Opt a route out of authentication. Everything else is denied by default
 * (`JwtAuthGuard` is global — design §9.1).
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
