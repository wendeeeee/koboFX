import { Injectable, Logger } from '@nestjs/common';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { UserRepository } from '../users/user.repository';
import { UserStatus } from '../users/user.types';
import { InvalidCredentialsError } from './auth.errors';
import { SessionResponse, TokenPairResponse } from './auth.types';
import { PasswordHasher } from './passwords/password-hasher';
import { SessionService } from './session.service';
import { RefreshTokenRevocationReason } from './tokens/refresh-token-rotation';
import { RefreshTokenService } from './tokens/refresh-token.service';

/**
 * Login, refresh and logout (design §9.1).
 *
 * Login does exactly one argon2 verification on every path — against a dummy hash
 * for an unknown email — and answers every failure with the same 401 (decision #6).
 * Brute force is bounded by the route's rate limits, keyed by IP + email and by email,
 * not by locking the account (a lockout would let anyone lock anyone out).
 */
@Injectable()
export class LoginService {
  private readonly logger = new Logger(LoginService.name);

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly users: UserRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly refreshTokens: RefreshTokenService,
    private readonly sessions: SessionService,
  ) {}

  async login(email: string, password: string): Promise<SessionResponse> {
    const user = await this.users.findCredentialsByEmail(email);
    const passwordMatches = user
      ? await this.passwordHasher.verify(user.passwordHash, password)
      : await this.passwordHasher.verifyAgainstDummy(password);
    if (!user || !passwordMatches || user.status !== UserStatus.ACTIVE) {
      this.logger.log({ userId: user?.id ?? null }, 'Login refused');
      throw new InvalidCredentialsError();
    }

    const refreshToken = await this.unitOfWork.run(async () => {
      if (this.passwordHasher.needsRehash(user.passwordHash)) {
        await this.users.replacePasswordHash(user.id, await this.passwordHasher.hash(password));
      }
      return this.refreshTokens.startFamily(user.id);
    });
    this.logger.log({ userId: user.id, refreshTokenFamilyId: refreshToken.familyId }, 'Login succeeded');
    return this.sessions.session(user, refreshToken);
  }

  async refresh(refreshToken: string): Promise<{ tokens: TokenPairResponse }> {
    const rotated = await this.refreshTokens.rotate(refreshToken);
    return { tokens: this.sessions.tokenPair(rotated.userId, rotated.refreshToken) };
  }

  /** Revoke the caller's own session (the family their access token belongs to). */
  async logout(userId: string, refreshTokenFamilyId: string): Promise<void> {
    await this.refreshTokens.revokeFamily(refreshTokenFamilyId, userId, RefreshTokenRevocationReason.LOGOUT, {
      type: 'USER',
      id: userId,
    });
    this.logger.log({ userId, refreshTokenFamilyId }, 'Logged out');
  }
}
