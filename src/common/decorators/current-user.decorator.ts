import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { InvariantViolationError } from '../errors';
import { AuthenticatedRequest, AuthenticatedUser } from '../guards/authenticated-request';

export function currentUserFrom(context: ExecutionContext): AuthenticatedUser {
  const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
  // Only reachable if a @Public() route asks for a user: a wiring bug, not a client error.
  if (!user) throw new InvariantViolationError('@CurrentUser() used on a route without an authenticated user.');
  return user;
}

/** The authenticated caller. Scope user-owned queries by `user.id` in the WHERE clause. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => currentUserFrom(context));
