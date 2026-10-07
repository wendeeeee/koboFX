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

/**
 * Withdrawal codes (2026-10-07 decision; PiggyVest-style step-up): the user asks for a code, the WORKER generates and
 * emails it (`WithdrawalCodeRequested.v1`; the plaintext never reaches Postgres, the outbox or a log), and the withdraw
 * request carries it. One code authorizes ONE admitted withdrawal of any amount for 10 minutes; a newer code supersedes
 * an older one; 5 wrong tries exhaust it.
 *
 * Checked INSIDE the idempotency barrier (a recorded deviation from "database-only handlers"): a same-key replay is
 * answered from the stored response before the handler runs, so it never needs the code again. Wrong tries are counted
 * in Redis, so a refused (rolled-back) request still counts. The code is consumed as the admission's LAST step, inside
 * its transaction: of two requests racing with one code, the second consume fails and its admission rolls back. A
 * refusal for money reasons (funds, limits) leaves the code usable. Redis down ⇒ `503 DEPENDENCY_UNAVAILABLE`
 * (transient: no key stored).
 */
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

  /** Ask the worker for a code. No code while new withdrawals are switched off (it could not be used). */
  async request(userId: string): Promise<WithdrawalCodeRequested> {
    await this.gate.assertOpen();
    await this.unitOfWork.run(() => this.outbox.enqueue(OutboxEventType.WITHDRAWAL_CODE_REQUESTED, userId, { userId }));
    this.logger.log({ userId }, 'Withdrawal code requested');
    return { status: 'REQUESTED', channel: 'EMAIL', expiresInSeconds: ONE_TIME_PASSWORD_TIME_TO_LIVE_SECONDS };
  }

  /** Count the try and compare (constant time). Every failure is the same `WITHDRAWAL_CODE_INVALID`. */
  async check(userId: string, candidate: string): Promise<MatchedWithdrawalCode> {
    const attempt = await this.store.attempt(PURPOSE, userId, ONE_TIME_PASSWORD_MAXIMUM_ATTEMPTS);
    if (attempt.kind === 'GONE') throw new WithdrawalCodeInvalidError();
    if (!oneTimePasswordMatches(this.pepper, attempt.challengeId, candidate, attempt.hmac)) {
      this.logger.log({ userId, attempt: attempt.attempt }, 'Withdrawal code attempt failed');
      // The challenge row's EXHAUSTED outcome is written in the request's transaction, which this refusal rolls back;
      // the Redis entry (the authority) is already gone, and the next issue closes the row EXPIRED/SUPERSEDED.
      if (attempt.lastAttempt) await this.challenges.resolve(attempt.challengeId, OneTimePasswordChallengeOutcome.EXHAUSTED);
      throw new WithdrawalCodeInvalidError();
    }
    return { challengeId: attempt.challengeId, lastAttempt: attempt.lastAttempt };
  }

  /** The admission's last step, inside its transaction: the code is used exactly once, or the admission rolls back. */
  async consume(userId: string, matched: MatchedWithdrawalCode): Promise<void> {
    if (!matched.lastAttempt && !(await this.store.consume(PURPOSE, userId, matched.challengeId))) {
      throw new WithdrawalCodeInvalidError(); // another request used (or a newer code replaced) it meanwhile
    }
    await this.challenges.resolve(matched.challengeId, OneTimePasswordChallengeOutcome.CONSUMED);
  }
}
