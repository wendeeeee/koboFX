import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccountSuspendedError, EmailNotVerifiedError } from '../../modules/auth/auth.errors';
import { UserStatus } from '../../modules/users/user.types';
import { ALLOW_UNVERIFIED_KEY } from '../decorators/allow-unverified.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthenticatedRequest } from './authenticated-request';

/**
 * Only verified, non-suspended users (design §7.1: "only verified users trade").
 * Global and deny-by-default, so no controller can forget it; `@AllowUnverified()`
 * opts out (logout). The status comes from the fresh database read in `JwtAuthGuard`.
 */
@Injectable()
export class VerifiedUserGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(ALLOW_UNVERIFIED_KEY, targets)) return true;
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (user?.status === UserStatus.ACTIVE) return true;
    if (user?.status === UserStatus.SUSPENDED) throw new AccountSuspendedError();
    throw new EmailNotVerifiedError();
  }
}
