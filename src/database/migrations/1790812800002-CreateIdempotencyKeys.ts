import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `idempotency_keys` (design §6.5), scoped per (user, endpoint, key). Keys never
 * expire: there is no `expires_at` (design §0.2 row 4).
 *
 * Deltas vs §6.5 (Phase 5 decisions):
 * - `status` is an enum.
 * - `response_body` is TEXT — the exact bytes sent — because JSONB reorders keys and a
 *   replay must be byte-identical.
 * - `flow_id` links a key to the flow it started (funding answers before any ledger
 *   transaction exists).
 * - The claim, the handler's work and the stored response commit in ONE transaction,
 *   so a committed `IN_PROGRESS` row never exists in practice; it is still a legal
 *   status so the single-statement claim of §6.5 keeps its shape.
 *
 * Identity and `request_hash` are immutable; `status` moves only IN_PROGRESS →
 * COMPLETED | FAILED_PERMANENT, after which the row is frozen. `fx_app` has no DELETE:
 * a transient failure rolls back and never commits a key.
 */
export class CreateIdempotencyKeys1790812800002 implements MigrationInterface {
  name = 'CreateIdempotencyKeys1790812800002';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE idempotency_key_status AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED_PERMANENT')`);
    await queryRunner.query(`
      CREATE TABLE idempotency_keys (
        user_id               UUID                   NOT NULL REFERENCES users (id),
        endpoint              TEXT                   NOT NULL,
        key                   TEXT                   NOT NULL,
        request_hash          CHAR(64)               NOT NULL,
        status                idempotency_key_status NOT NULL DEFAULT 'IN_PROGRESS',
        response_status_code  INTEGER,
        response_body         TEXT,
        flow_id               UUID                   REFERENCES flow_instances (id),
        transaction_id        UUID                   REFERENCES transactions (id),
        created_at            TIMESTAMPTZ            NOT NULL DEFAULT now(),
        completed_at          TIMESTAMPTZ,

        PRIMARY KEY (user_id, endpoint, key),
        CONSTRAINT idempotency_keys_key_format CHECK (key ~ '^[A-Za-z0-9_-]{16,128}$'),
        CONSTRAINT idempotency_keys_endpoint_format CHECK (endpoint ~ '^[A-Z]+ /[A-Za-z0-9/:_-]*$'),
        CONSTRAINT idempotency_keys_request_hash_format CHECK (request_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT idempotency_keys_completed_when_final CHECK ((status = 'IN_PROGRESS') = (completed_at IS NULL)),
        CONSTRAINT idempotency_keys_response_when_final CHECK (
          (status = 'IN_PROGRESS') = (response_status_code IS NULL)
          AND (status = 'IN_PROGRESS') = (response_body IS NULL)
        ),
        CONSTRAINT idempotency_keys_response_status_range CHECK (response_status_code BETWEEN 100 AND 599)
      )
    `);

    await queryRunner.query(`
      CREATE FUNCTION idempotency_keys_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'idempotency keys never expire and are never deleted'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.endpoint IS DISTINCT FROM OLD.endpoint
           OR NEW.key IS DISTINCT FROM OLD.key OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'idempotency key identity and request hash are immutable'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF OLD.status <> 'IN_PROGRESS' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
          RAISE EXCEPTION 'idempotency key outcome is final'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER idempotency_keys_guard_mutation BEFORE UPDATE OR DELETE ON idempotency_keys
        FOR EACH ROW EXECUTE FUNCTION idempotency_keys_guard_mutation()
    `);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON idempotency_keys FROM fx_app`);
    await queryRunner.query(`
      GRANT UPDATE (status, response_status_code, response_body, flow_id, transaction_id, completed_at)
        ON idempotency_keys TO fx_app
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE idempotency_keys`);
    await queryRunner.query(`DROP FUNCTION idempotency_keys_guard_mutation()`);
    await queryRunner.query(`DROP TYPE idempotency_key_status`);
  }
}
