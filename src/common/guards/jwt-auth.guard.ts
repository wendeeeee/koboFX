import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessTokenService } from '../../modules/auth/tokens/access-token.service';
import { UserRepository } from '../../modules/users/user.repository';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { UnauthenticatedError } from '../errors';
import { AuthenticatedRequest } from './authenticated-request';

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

export function bearerToken(authorization: string | undefined): string | undefined {
  return authorization ? BEARER.exec(authorization)?.[1] : undefined;
}

/**
 * Deny by default (design §9.1): global, so every route needs a valid access token
 * unless it is marked `@Public()`.
 *
 * A valid signature is not enough. The user's status and role, and whether the
 * session was revoked, are re-read from the database on every request (decision #8):
 * one indexed lookup buys immediate logout and suspension.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenService,
    private readonly users: UserRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request.headers.authorization);
    if (!token) throw new UnauthenticatedError('Authentication is required.');
    const claims = this.accessTokens.verify(token);
    const state = await this.users.findAuthenticationState(claims.userId, claims.refreshTokenFamilyId);
    if (!state || state.sessionRevoked) throw new UnauthenticatedError('Authentication is required.');
    request.user = Object.freeze({
      id: state.userId,
      role: state.role,
      status: state.status,
      refreshTokenFamilyId: claims.refreshTokenFamilyId,
    });
    return true;
  }
}
