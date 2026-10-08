import { Injectable } from '@nestjs/common';
import { UserProfile } from '../users/user.repository';
import { SessionResponse, TokenPairResponse, toSafeUser } from './auth.types';
import { AccessTokenService } from './tokens/access-token.service';
import { IssuedRefreshToken } from './tokens/refresh-token.service';

@Injectable()
export class SessionService {
  constructor(private readonly accessTokens: AccessTokenService) {}

  tokenPair(userId: string, refreshToken: IssuedRefreshToken): TokenPairResponse {
    const access = this.accessTokens.issue(userId, refreshToken.familyId);
    return {
      tokenType: 'Bearer',
      access: { token: access.token, expiresAt: access.expiresAt.toISOString() },
      refresh: { token: refreshToken.token, expiresAt: refreshToken.expiresAt.toISOString() },
    };
  }

  session(profile: UserProfile, refreshToken: IssuedRefreshToken): SessionResponse {
    return { user: toSafeUser(profile), tokens: this.tokenPair(profile.id, refreshToken) };
  }
}
