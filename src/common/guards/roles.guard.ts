import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../modules/users/user.types';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { ForbiddenError, UnauthenticatedError } from '../errors';
import { AuthenticatedRequest } from './authenticated-request';

/** RBAC (design §9.3). Routes without `@Roles()` are open to any authenticated user. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    // @Roles on a @Public route would be a contradiction: refuse rather than guess.
    if (!user) throw new UnauthenticatedError('Authentication is required.');
    if (!roles.includes(user.role)) throw new ForbiddenError('You do not have permission to do this.');
    return true;
  }
}
