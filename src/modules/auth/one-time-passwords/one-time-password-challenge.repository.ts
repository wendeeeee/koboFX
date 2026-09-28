import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { OneTimePasswordPurpose } from './one-time-password';

/** `one_time_password_challenge_outcome`. */
export enum OneTimePasswordChallengeOutcome {
  CONSUMED = 'CONSUMED',
  EXHAUSTED = 'EXHAUSTED',
  SUPERSEDED = 'SUPERSEDED',
  EXPIRED = 'EXPIRED',
}

/**
 * `one_time_password_challenges`: the audit record that a challenge was issued and how
 * it ended. Never the code, never its HMAC.
 */
@Injectable()
export class OneTimePasswordChallengeRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /**
   * Resolve the open challenge (if any) before issuing a new one: EXPIRED if it ran
   * out, SUPERSEDED otherwise. At most one open challenge per user and purpose is a
   * unique index, so this must precede `insertIssued` in the same transaction.
   */
  async closeOpen(purpose: OneTimePasswordPurpose, userId: string): Promise<void> {
    await this.unitOfWork.requireTransaction().query(
      `UPDATE one_time_password_challenges
          SET outcome = CASE WHEN expires_at <= now() THEN 'EXPIRED' ELSE 'SUPERSEDED' END::one_time_password_challenge_outcome,
              resolved_at = now()
        WHERE user_id = $1 AND purpose = $2 AND outcome IS NULL`,
      [userId, purpose],
    );
  }

  async insertIssued(
    challengeId: string,
    purpose: OneTimePasswordPurpose,
    userId: string,
    outboxEventId: string,
    timeToLiveSeconds: number,
  ): Promise<void> {
    await this.unitOfWork.requireTransaction().query(
      `INSERT INTO one_time_password_challenges (id, user_id, purpose, outbox_event_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
      [challengeId, userId, purpose, outboxEventId, timeToLiveSeconds],
    );
  }

  /** Record how a challenge ended. Set once: a challenge already resolved is left as it is. */
  async resolve(challengeId: string, outcome: OneTimePasswordChallengeOutcome): Promise<void> {
    await this.unitOfWork.manager.query(
      `UPDATE one_time_password_challenges SET outcome = $2, resolved_at = now() WHERE id = $1 AND outcome IS NULL`,
      [challengeId, outcome],
    );
  }
}
