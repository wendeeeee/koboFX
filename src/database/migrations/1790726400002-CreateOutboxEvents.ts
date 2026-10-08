import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `outbox_events` (design §7.6; handbook: notifying reliably). Written in the same
 * transaction as the state change, drained by the worker's dispatcher.
 *
 * Columns added vs §7.6: `last_error` (why the latest attempt failed) and `failed_at`
 * (dead-lettered after the configured number of attempts — kept, never deleted, so the
 * failure stays visible and replayable).
 *
 * - `next_attempt_at` doubles as the claim lease: claiming a row pushes it into the
 *   future, so a dispatcher that dies mid-delivery simply lets the lease lapse and the
 *   event is delivered again (at-least-once; consumers are idempotent).
 * - `event_type` is versioned (`….v1`): events outlive the code that wrote them.
 * - Payloads carry opaque ids only — never personal data, never a credential — so the
 *   outbox needs no crypto-shredding (design §9.5).
 * - The event itself is immutable; only its delivery columns change, `published_at`
 *   and `failed_at` once each. `fx_app` has no DELETE.
 */
export class CreateOutboxEvents1790726400002 implements MigrationInterface {
  name = 'CreateOutboxEvents1790726400002';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE outbox_events (
        id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type       TEXT        NOT NULL,
        aggregate_id     UUID        NOT NULL,
        payload          JSONB       NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        published_at     TIMESTAMPTZ,
        attempts         INTEGER     NOT NULL DEFAULT 0,
        next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_error       TEXT,
        failed_at        TIMESTAMPTZ,

        CONSTRAINT outbox_events_type_versioned CHECK (event_type ~ '^[A-Za-z]+\\.v[0-9]+$'),
        CONSTRAINT outbox_events_attempts_non_negative CHECK (attempts >= 0),
        CONSTRAINT outbox_events_single_terminal_state CHECK (published_at IS NULL OR failed_at IS NULL)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX outbox_events_due_index ON outbox_events (next_attempt_at)
        WHERE published_at IS NULL AND failed_at IS NULL
    `);

    await queryRunner.query(`
      CREATE FUNCTION outbox_events_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'outbox events are never deleted (attempted DELETE on id %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF (to_jsonb(NEW) - 'published_at' - 'attempts' - 'next_attempt_at' - 'last_error' - 'failed_at')
           IS DISTINCT FROM (to_jsonb(OLD) - 'published_at' - 'attempts' - 'next_attempt_at' - 'last_error' - 'failed_at') THEN
          RAISE EXCEPTION 'outbox event % is immutable apart from its delivery state', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF (OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at)
           OR (OLD.failed_at IS NOT NULL AND NEW.failed_at IS DISTINCT FROM OLD.failed_at) THEN
          RAISE EXCEPTION 'outbox event % has already reached a terminal state', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER outbox_events_guard_mutation BEFORE UPDATE OR DELETE ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION outbox_events_guard_mutation()
    `);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON outbox_events FROM fx_app`);
    await queryRunner.query(`
      GRANT UPDATE (published_at, attempts, next_attempt_at, last_error, failed_at) ON outbox_events TO fx_app
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE outbox_events`);
    await queryRunner.query(`DROP FUNCTION outbox_events_guard_mutation()`);
  }
}
