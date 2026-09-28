import type { Request } from 'express';
import { UserRole, UserStatus } from '../../modules/users/user.types';

/**
 * Who is calling, as established by `JwtAuthGuard` from the token AND a fresh read
 * of the database. Frozen: nothing downstream can promote itself.
 *
 * `id` is what every user-owned query is scoped by, in its WHERE clause (design §9.1,
 * object-level authorization): take it from here, never from the request body.
 */
export interface AuthenticatedUser {
  readonly id: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  /** The login session (refresh token family) the access token belongs to. */
  readonly refreshTokenFamilyId: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}
