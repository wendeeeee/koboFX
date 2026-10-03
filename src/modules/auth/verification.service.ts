import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { AuditAction, AuditLogService, AuditSubjectType } from '../audit/audit-log.service';
import { OutboxService } from '../outbox/outbox.service';
import { OutboxEventType } from '../outbox/outbox.types';
import { UserRepository } from '../users/user.repository';
import { UserStatus } from '../users/user.types';
import { WalletProvisioningService } from '../wallets/wallet-provisioning.service';
import { VerificationFailedError } from './auth.errors';
import { SessionResponse } from './auth.types';
import {
  ONE_TIME_PASSWORD_MAXIMUM_ATTEMPTS,
  OneTimePasswordPurpose,
  oneTimePasswordMatches,
} from './one-time-passwords/one-time-password';
import {
  OneTimePasswordChallengeOutcome,
  OneTimePasswordChallengeRepository,
} from './one-time-passwords/one-time-password-challenge.repository';
import { OneTimePasswordChallengeStore } from './one-time-passwords/one-time-password-challenge.store';
import { PasswordHasher } from './passwords/password-hasher';
import { SessionService } from './session.service';
import { RefreshTokenService } from './tokens/refresh-token.service';

/**
 * Email verification and code resend.
 * Verify takes the email, the code AND the password
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);
  private readonly pepper: Buffer;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly users: UserRepository,
    private readonly challengeStore: OneTimePasswordChallengeStore,
    private readonly challenges: OneTimePasswordChallengeRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly wallets: WalletProvisioningService,
    private readonly auditLog: AuditLogService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly sessions: SessionService,
    private readonly outbox: OutboxService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.pepper = config.authentication.oneTimePasswordPepper;
  }

  async verifyEmail(email: string, password: string, oneTimePassword: string): Promise<SessionResponse> {
    const purpose = OneTimePasswordPurpose.VERIFY_EMAIL;
    const user = await this.users.findCredentialsByEmail(email);
    const attempt = user
      ? await this.challengeStore.attempt(purpose, user.id, ONE_TIME_PASSWORD_MAXIMUM_ATTEMPTS)
      : ({ kind: 'GONE' } as const);
    const passwordMatches = user
      ? await this.passwordHasher.verify(user.passwordHash, password)
      : await this.passwordHasher.verifyAgainstDummy(password);

    if (!user || attempt.kind === 'GONE') throw new VerificationFailedError();
    const codeMatches = oneTimePasswordMatches(this.pepper, attempt.challengeId, oneTimePassword, attempt.hmac);
    if (!codeMatches || !passwordMatches) {
      if (attempt.lastAttempt) {
        await this.challenges.resolve(attempt.challengeId, OneTimePasswordChallengeOutcome.EXHAUSTED);
      }
      this.logger.log({ userId: user.id, attempt: attempt.attempt }, 'Email verification attempt failed');
      throw new VerificationFailedError();
    }
    if (!attempt.lastAttempt && !(await this.challengeStore.consume(purpose, user.id, attempt.challengeId))) {
      throw new VerificationFailedError();
    }

    const session = await this.unitOfWork.run(async () => {
      const activated = await this.users.activate(user.id);
      if (!activated) throw new VerificationFailedError();
      await this.challenges.resolve(attempt.challengeId, OneTimePasswordChallengeOutcome.CONSUMED);
      await this.auditLog.record({
        actor: { type: 'USER', id: user.id },
        action: AuditAction.USER_VERIFIED,
        subject: { type: AuditSubjectType.USER, id: user.id },
        before: { status: UserStatus.PENDING_VERIFICATION, verified: false },
        after: { status: UserStatus.ACTIVE, verified: true },
        reason: 'Email ownership proven with a one-time password',
      });
      await this.wallets.postDemoCreditIfEnabled(user.id);
      const refreshToken = await this.refreshTokens.startFamily(user.id);
      return { profile: activated, refreshToken };
    });
    this.logger.log({ userId: user.id }, 'Email verified; account active');
    return this.sessions.session(session.profile, session.refreshToken);
  }

 
  async resendVerificationCode(email: string): Promise<void> {
    const user = await this.users.findCredentialsByEmail(email);
    if (user?.status !== UserStatus.PENDING_VERIFICATION) return;
    await this.unitOfWork.run(() =>
      this.outbox.enqueue(OutboxEventType.EMAIL_VERIFICATION_REQUESTED, user.id, { userId: user.id }),
    );
    this.logger.log({ userId: user.id }, 'Verification code re-requested');
  }
}
