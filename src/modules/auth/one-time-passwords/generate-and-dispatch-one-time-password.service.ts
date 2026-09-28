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
 * Issues and emails a one-time password (decision #2). Runs in the WORKER, when an
 * `EmailVerificationRequested.v1` outbox event is handled — never in the API — so the
 * plaintext code exists only in this process's memory: not in Postgres, not in the
 * outbox payload, not in a log line.
 *
 * Steps:
 * 1. One short transaction, under the user's row lock (so issuances for one user
 *    serialise and Redis always holds the challenge the database says is open):
 *    close the previous challenge, record the new one, store its HMAC in Redis.
 * 2. After commit, send the email. No transaction is held across SMTP.
 *
 * At-least-once: a redelivered event issues a fresh challenge that supersedes the
 * first, so at worst the user gets two emails and only the newer code works. The TTL
 * starts when the email is sent, not when the user registered.
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
