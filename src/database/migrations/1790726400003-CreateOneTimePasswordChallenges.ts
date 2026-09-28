import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `one_time_password_challenges` — the design's `otp_challenges` (§7.1), spelled out
 * per the naming rule. It records only THAT a challenge was issued and how it ended,
 * for the audit trail. The code and its HMAC live in Redis only; neither is ever here.
 *
 * - `id` is the challenge id also held in Redis, so a Redis entry maps to one row.
 * - `outcome` is set once: CONSUMED (verified), EXHAUSTED (5 wrong attempts),
 *   SUPERSEDED (a newer challenge replaced it) or EXPIRED (found past its TTL when a
 *   newer one was issued). An open challenge past `expires_at` is simply expired.
 * - At most one open challenge per user and purpose (partial unique index): issuing
 *   a new one must resolve the previous one first, in the same transaction.
 * - Immutable apart from `outcome`/`resolved_at`; `fx_app` has no DELETE.
 */
export class CreateOneTimePasswordChallenges1790726400003 implements MigrationInterface {
  name = 'CreateOneTimePasswordChallenges1790726400003';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE one_time_password_purpose AS ENUM ('VERIFY_EMAIL')`);
    await queryRunner.query(`
      CREATE TYPE one_time_password_challenge_outcome AS ENUM ('CONSUMED', 'EXHAUSTED', 'SUPERSEDED', 'EXPIRED')
    `);
    await queryRunner.query(`
      CREATE TABLE one_time_password_challenges (
        id               UUID                                 PRIMARY KEY,
        user_id          UUID                                 NOT NULL REFERENCES users (id),
        purpose          one_time_password_purpose            NOT NULL,
        outbox_event_id  UUID                                 NOT NULL REFERENCES outbox_events (id),
        issued_at        TIMESTAMPTZ                          NOT NULL DEFAULT now(),
        expires_at       TIMESTAMPTZ                          NOT NULL,
        outcome          one_time_password_challenge_outcome,
        resolved_at      TIMESTAMPTZ,

        CONSTRAINT one_time_password_challenges_resolution_recorded CHECK ((outcome IS NULL) = (resolved_at IS NULL)),
        CONSTRAINT one_time_password_challenges_expiry_after_issue CHECK (expires_at > issued_at)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX one_time_password_challenges_open_unique
        ON one_time_password_challenges (user_id, purpose) WHERE outcome IS NULL
    `);

    await queryRunner.query(`
      CREATE FUNCTION one_time_password_challenges_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'one-time password challenges are never deleted (attempted DELETE on id %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF (to_jsonb(NEW) - 'outcome' - 'resolved_at') IS DISTINCT FROM (to_jsonb(OLD) - 'outcome' - 'resolved_at') THEN
          RAISE EXCEPTION 'one-time password challenge % is immutable apart from its outcome', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF OLD.outcome IS NOT NULL
           AND (NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at) THEN
          RAISE EXCEPTION 'one-time password challenge % has already been resolved as %', OLD.id, OLD.outcome
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER one_time_password_challenges_guard_mutation BEFORE UPDATE OR DELETE ON one_time_password_challenges
        FOR EACH ROW EXECUTE FUNCTION one_time_password_challenges_guard_mutation()
    `);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON one_time_password_challenges FROM fx_app`);
    await queryRunner.query(`GRANT UPDATE (outcome, resolved_at) ON one_time_password_challenges TO fx_app`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE one_time_password_challenges`);
    await queryRunner.query(`DROP FUNCTION one_time_password_challenges_guard_mutation()`);
    await queryRunner.query(`DROP TYPE one_time_password_challenge_outcome`);
    await queryRunner.query(`DROP TYPE one_time_password_purpose`);
  }
}
