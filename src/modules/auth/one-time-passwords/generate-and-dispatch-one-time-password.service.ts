import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { EmailSender } from '../../notifications/email/email-sender';
import { verificationCodeEmail } from '../../notifications/email/email-templates';
import { UserStatus } from '../../users/user.types';
import {
  ONE_TIME_PASSWORD_TIME_TO_LIVE_SECONDS,
  OneTimePasswordPurpose,
  generateOneTimePassword,
  hashOneTimePassword,
} from './one-time-password';
import { OneTimePasswordChallengeRepository } from './one-time-password-challenge.repository';
import { OneTimePasswordChallengeStore } from './one-time-password-challenge.store';

export type DispatchOutcome = 'SENT' | 'NOT_PENDING';

/**
 * Issues and emails a one-time password. Runs in the separate WORKER, when an
 * `EmailVerificationRequested.v1` outbox event is handled.
 */
@Injectable()
export class GenerateAndDispatchOneTimePasswordService {
  private readonly logger = new Logger(GenerateAndDispatchOneTimePasswordService.name);
  private readonly pepper: Buffer;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly challenges: OneTimePasswordChallengeRepository,
    private readonly challengeStore: OneTimePasswordChallengeStore,
    private readonly emailSender: EmailSender,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.pepper = config.authentication.oneTimePasswordPepper;
  }

  async dispatchEmailVerification(userId: string, outboxEventId: string): Promise<DispatchOutcome> {
    const purpose = OneTimePasswordPurpose.VERIFY_EMAIL;
    const oneTimePassword = generateOneTimePassword();
    const challengeId = randomUUID();

    const recipient = await this.unitOfWork.run(async (manager) => {
      const [user] = (await manager.query(`SELECT email, status FROM users WHERE id = $1 FOR UPDATE`, [userId])) as {
        email: string;
        status: UserStatus;
      }[];
      if (user?.status !== UserStatus.PENDING_VERIFICATION) return null;
      await this.challenges.closeOpen(purpose, userId);
      await this.challenges.insertIssued(challengeId, purpose, userId, outboxEventId, ONE_TIME_PASSWORD_TIME_TO_LIVE_SECONDS);
      await this.challengeStore.store(
        purpose,
        userId,
        challengeId,
        hashOneTimePassword(this.pepper, challengeId, oneTimePassword),
        ONE_TIME_PASSWORD_TIME_TO_LIVE_SECONDS,
      );
      return user.email;
    });
    if (recipient === null) {
      this.logger.log({ userId }, 'Verification code not sent: the user is no longer pending verification');
      return 'NOT_PENDING';
    }

    await this.emailSender.send(
      verificationCodeEmail(recipient, oneTimePassword, ONE_TIME_PASSWORD_TIME_TO_LIVE_SECONDS / 60),
    );
    this.logger.log({ userId, challengeId }, 'Verification code sent');
    return 'SENT';
  }
}
