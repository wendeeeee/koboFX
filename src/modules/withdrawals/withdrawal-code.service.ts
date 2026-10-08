import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import {
  ONE_TIME_PASSWORD_MAXIMUM_ATTEMPTS,
  ONE_TIME_PASSWORD_TIME_TO_LIVE_SECONDS,
  OneTimePasswordPurpose,
  oneTimePasswordMatches,
} from '../auth/one-time-passwords/one-time-password';
import {
  OneTimePasswordChallengeOutcome,
  OneTimePasswordChallengeRepository,
} from '../auth/one-time-passwords/one-time-password-challenge.repository';
import { OneTimePasswordChallengeStore } from '../auth/one-time-passwords/one-time-password-challenge.store';
import { OutboxService } from '../outbox/outbox.service';
import { OutboxEventType } from '../outbox/outbox.types';
import { WithdrawalAdmissionGate } from './withdrawal-admission-gate';
import { WithdrawalCodeInvalidError } from './withdrawals.errors';

const PURPOSE = OneTimePasswordPurpose.AUTHORIZE_WITHDRAWAL;

export interface WithdrawalCodeRequested {
  readonly status: 'REQUESTED';
  readonly channel: 'EMAIL';
  readonly expiresInSeconds: number;
}

/** A code that matched; it authorizes the withdrawal only once `consume` succeeds inside the admission transaction. */
export interface MatchedWithdrawalCode {
  readonly challengeId: string;
  /** The attempt that used up the challenge: Redis already deleted it, so it is consumed by construction. */
  readonly lastAttempt: boolean;
}


@Injectable()
export class WithdrawalCodeService {
  private readonly logger = new Logger(WithdrawalCodeService.name);
  private readonly pepper: Buffer;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: OneTimePasswordChallengeStore,
    private readonly challenges: OneTimePasswordChallengeRepository,
    private readonly outbox: OutboxService,
    private readonly gate: WithdrawalAdmissionGate,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.pepper = config.authentication.oneTimePasswordPepper;
  }

 
  async request(userId: string): Promise<WithdrawalCodeRequested> {
    await this.gate.assertOpen();
    await this.unitOfWork.run(() => this.outbox.enqueue(OutboxEventType.WITHDRAWAL_CODE_REQUESTED, userId, { userId }));
    this.logger.log({ userId }, 'Withdrawal code requested');
    return { status: 'REQUESTED', channel: 'EMAIL', expiresInSeconds: ONE_TIME_PASSWORD_TIME_TO_LIVE_SECONDS };
  }

 
  async check(userId: string, candidate: string): Promise<MatchedWithdrawalCode> {
    const attempt = await this.store.attempt(PURPOSE, userId, ONE_TIME_PASSWORD_MAXIMUM_ATTEMPTS);
    if (attempt.kind === 'GONE') throw new WithdrawalCodeInvalidError();
    if (!oneTimePasswordMatches(this.pepper, attempt.challengeId, candidate, attempt.hmac)) {
      this.logger.log({ userId, attempt: attempt.attempt }, 'Withdrawal code attempt failed');
    
      if (attempt.lastAttempt) await this.challenges.resolve(attempt.challengeId, OneTimePasswordChallengeOutcome.EXHAUSTED);
      throw new WithdrawalCodeInvalidError();
    }
    return { challengeId: attempt.challengeId, lastAttempt: attempt.lastAttempt };
  }


  async consume(userId: string, matched: MatchedWithdrawalCode): Promise<void> {
    if (!matched.lastAttempt && !(await this.store.consume(PURPOSE, userId, matched.challengeId))) {
      throw new WithdrawalCodeInvalidError(); 
    }
    await this.challenges.resolve(matched.challengeId, OneTimePasswordChallengeOutcome.CONSUMED);
  }
}
