import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `webhook_events` (design §7.3): every inbound webhook, verbatim, before anything acts
 * on it.
 *
 * Deltas vs §7.3 (Phase 5 decisions):
 * - The dedupe index is PARTIAL, `WHERE signature_valid`: a forged event stored first
 *   must never suppress the genuine event with the same id (event-id poisoning).
 *   Invalid-signature rows are kept (a security signal) but never deduplicated or
 *   processed.
 * - `provider_event_id` is nullable: an invalid or unparseable body has none we trust.
 * - Processing columns: `next_attempt_at` (claim lease + backoff, as in the outbox),
 *   `outcome`, `last_error`.
 * - The evidence (`id`, `provider`, `provider_event_id`, `raw_payload`, `headers`,
 *   `signature_valid`, `received_at`) is immutable **even for a superuser** (trigger),
 *   `processed_at`/`outcome` are set once, and nothing is ever deleted or truncated.
 */
export class CreateWebhookEvents1790812800003 implements MigrationInterface {
  name = 'CreateWebhookEvents1790812800003';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE webhook_event_outcome AS ENUM
        ('ADVANCED', 'NO_CHANGE', 'UNMATCHED', 'UNCONFIRMED', 'INVALID_SIGNATURE', 'MALFORMED')
    `);
    await queryRunner.query(`
      CREATE TABLE webhook_events (
        id                 UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
        provider           TEXT                  NOT NULL,
        provider_event_id  TEXT,
        raw_payload        BYTEA                 NOT NULL,
        headers            JSONB                 NOT NULL,
        signature_valid    BOOLEAN               NOT NULL,
        received_at        TIMESTAMPTZ           NOT NULL DEFAULT now(),
        processed_at       TIMESTAMPTZ,
        outcome            webhook_event_outcome,
        attempts           INTEGER               NOT NULL DEFAULT 0,
        next_attempt_at    TIMESTAMPTZ           NOT NULL DEFAULT now(),
        last_error         TEXT,

        CONSTRAINT webhook_events_outcome_when_processed CHECK ((processed_at IS NULL) = (outcome IS NULL)),
        CONSTRAINT webhook_events_invalid_never_processed CHECK (signature_valid OR outcome IS NOT DISTINCT FROM 'INVALID_SIGNATURE'),
        CONSTRAINT webhook_events_attempts_non_negative CHECK (attempts >= 0)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX webhook_events_provider_event_unique ON webhook_events (provider, provider_event_id)
        WHERE signature_valid AND provider_event_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX webhook_events_due_index ON webhook_events (next_attempt_at) WHERE processed_at IS NULL
    `);

    await queryRunner.query(`
      CREATE FUNCTION webhook_events_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
          RAISE EXCEPTION 'webhook events are evidence and are never deleted'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.provider IS DISTINCT FROM OLD.provider
           OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id
           OR NEW.raw_payload IS DISTINCT FROM OLD.raw_payload OR NEW.headers IS DISTINCT FROM OLD.headers
           OR NEW.signature_valid IS DISTINCT FROM OLD.signature_valid
           OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
          RAISE EXCEPTION 'webhook event % is evidence: what the provider sent is immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF (OLD.processed_at IS NOT NULL AND NEW.processed_at IS DISTINCT FROM OLD.processed_at)
           OR (OLD.outcome IS NOT NULL AND NEW.outcome IS DISTINCT FROM OLD.outcome) THEN
          RAISE EXCEPTION 'webhook event % has already been processed', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER webhook_events_guard_mutation BEFORE UPDATE OR DELETE ON webhook_events
        FOR EACH ROW EXECUTE FUNCTION webhook_events_guard_mutation()
    `);
    await queryRunner.query(`
      CREATE TRIGGER webhook_events_guard_truncate BEFORE TRUNCATE ON webhook_events
        FOR EACH STATEMENT EXECUTE FUNCTION webhook_events_guard_mutation()
    `);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON webhook_events FROM fx_app`);
    await queryRunner.query(`
      GRANT UPDATE (processed_at, outcome, attempts, next_attempt_at, last_error) ON webhook_events TO fx_app
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE webhook_events`);
    await queryRunner.query(`DROP FUNCTION webhook_events_guard_mutation()`);
    await queryRunner.query(`DROP TYPE webhook_event_outcome`);
  }
}
