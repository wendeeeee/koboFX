import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `audit_logs` (design §9.3; handbook: audits and audit trails): what, when, who, why,
 * for changes that are not money movements — verification, session revocation, and
 * (Phase 10) role and status changes.
 *
 * - Append-only: a row trigger RAISEs on UPDATE and DELETE, a statement trigger on
 *   TRUNCATE, and `fx_app` holds only SELECT and INSERT.
 * - No personal data. Rows can never be deleted, so they reference people only by
 *   opaque id (design §9.5): no email, no IP address, no credential material.
 *   `AuditLogService` accepts only a typed set of state fields to enforce that.
 */
export class CreateAuditLogs1790726400001 implements MigrationInterface {
  name = 'CreateAuditLogs1790726400001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE audit_actor_type AS ENUM ('USER', 'OPERATOR', 'SYSTEM')`);
    await queryRunner.query(`
      CREATE TABLE audit_logs (
        id              UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
        occurred_at     TIMESTAMPTZ      NOT NULL DEFAULT now(),
        actor_type      audit_actor_type NOT NULL,
        actor_id        UUID             REFERENCES users (id),
        action          TEXT             NOT NULL,
        subject_type    TEXT             NOT NULL,
        subject_id      UUID             NOT NULL,
        before          JSONB,
        after           JSONB,
        reason          TEXT             NOT NULL,
        correlation_id  TEXT,

        CONSTRAINT audit_logs_actor_identified CHECK ((actor_type = 'SYSTEM') = (actor_id IS NULL)),
        CONSTRAINT audit_logs_action_format CHECK (action ~ '^[A-Z][A-Z_]*$'),
        CONSTRAINT audit_logs_subject_type_format CHECK (subject_type ~ '^[A-Z][A-Z_]*$'),
        CONSTRAINT audit_logs_reason_present CHECK (length(reason) > 0)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX audit_logs_subject_index ON audit_logs (subject_type, subject_id, occurred_at)
    `);
    await queryRunner.query(`CREATE INDEX audit_logs_actor_index ON audit_logs (actor_id) WHERE actor_id IS NOT NULL`);

    await queryRunner.query(`
      CREATE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit_logs is append-only (attempted %)', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER audit_logs_no_mutation BEFORE UPDATE OR DELETE ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only()
    `);
    await queryRunner.query(`
      CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
        FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only()
    `);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM fx_app`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE audit_logs`);
    await queryRunner.query(`DROP FUNCTION audit_logs_append_only()`);
    await queryRunner.query(`DROP TYPE audit_actor_type`);
  }
}
