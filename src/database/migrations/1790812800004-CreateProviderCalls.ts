import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `provider_calls` (design §7.2; handbook: "store every request and response"). One
 * row per outbound attempt and per inbound webhook, secrets and card data redacted
 * before insert.
 *
 * Deltas vs §7.2 (Phase 5 decisions): `duration_milliseconds` (naming rule),
 * `request_method` + `request_path` + `attempt` (which call, which try), and
 * `webhook_event_id` linking an INBOUND row to its raw event.
 *
 * Append-only evidence: UPDATE, DELETE and TRUNCATE raise — for a superuser too.
 * Monthly partitioning with 24-month retention (§7.2) is deferred (CLAUDE.md).
 */
export class CreateProviderCalls1790812800004 implements MigrationInterface {
  name = 'CreateProviderCalls1790812800004';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE provider_call_direction AS ENUM ('OUTBOUND', 'INBOUND')`);
    await queryRunner.query(`
      CREATE TABLE provider_calls (
        id                     BIGINT                  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        provider               TEXT                    NOT NULL,
        operation              TEXT                    NOT NULL,
        direction              provider_call_direction NOT NULL,
        correlation_id         TEXT                    NOT NULL,
        flow_id                UUID                    REFERENCES flow_instances (id),
        webhook_event_id       UUID                    REFERENCES webhook_events (id),
        request_method         TEXT,
        request_path           TEXT,
        attempt                INTEGER                 NOT NULL DEFAULT 1,
        request_body           JSONB,
        response_status        INTEGER,
        response_body          JSONB,
        duration_milliseconds  INTEGER,
        error                  TEXT,
        created_at             TIMESTAMPTZ             NOT NULL DEFAULT now(),

        CONSTRAINT provider_calls_attempt_positive CHECK (attempt >= 1),
        CONSTRAINT provider_calls_duration_non_negative CHECK (duration_milliseconds >= 0)
      )
    `);
    await queryRunner.query(`CREATE INDEX provider_calls_flow_index ON provider_calls (flow_id) WHERE flow_id IS NOT NULL`);

    await queryRunner.query(`
      CREATE FUNCTION provider_calls_refuse_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'provider calls are append-only evidence (attempted %)', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER provider_calls_refuse_mutation BEFORE UPDATE OR DELETE ON provider_calls
        FOR EACH ROW EXECUTE FUNCTION provider_calls_refuse_mutation()
    `);
    await queryRunner.query(`
      CREATE TRIGGER provider_calls_refuse_truncate BEFORE TRUNCATE ON provider_calls
        FOR EACH STATEMENT EXECUTE FUNCTION provider_calls_refuse_mutation()
    `);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON provider_calls FROM fx_app`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE provider_calls`);
    await queryRunner.query(`DROP FUNCTION provider_calls_refuse_mutation()`);
    await queryRunner.query(`DROP TYPE provider_call_direction`);
  }
}
