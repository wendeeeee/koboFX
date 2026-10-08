import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { OneTimePasswordPurpose } from './one-time-password';

export enum OneTimePasswordChallengeOutcome {
  CONSUMED = 'CONSUMED',
  EXHAUSTED = 'EXHAUSTED',
  SUPERSEDED = 'SUPERSEDED',
  EXPIRED = 'EXPIRED',
}


@Injectable()
export class OneTimePasswordChallengeRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /**
   * Resolve the open challenge (if any) before issuing a new one: EXPIRED if it ran
   * out, SUPERSEDED otherwise.
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

  async resolve(challengeId: string, outcome: OneTimePasswordChallengeOutcome): Promise<void> {
    await this.unitOfWork.manager.query(
      `UPDATE one_time_password_challenges SET outcome = $2, resolved_at = now() WHERE id = $1 AND outcome IS NULL`,
      [challengeId, outcome],
    );
  }
}
