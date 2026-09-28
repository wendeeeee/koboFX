import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `reservations` (design §6.3), with full names in place of the design's abbreviations
 * (`reservations_active_account_index`, `reservations_active_expiry_index`).
 *
 * Decisions (CLAUDE.md, Phase 3):
 * - `flow_id` has NO foreign key yet: Phase 5 adds `REFERENCES flow_instances(id)` in
 *   the migration that creates `flow_instances` (same pattern as `quotes`).
 * - `settlement_transaction_id` (not in §6.3) links a settlement to its posting, so a
 *   retried settle can return the original settlement.
 * - One reservation per `(flow_id, account_id)`, ever — a retried reserve returns it,
 *   even after it resolved (handbook: idempotency, out-of-order retries).
 * - Rows are immutable apart from resolving: `status` moves only ACTIVE → SETTLED |
 *   RELEASED | EXPIRED, or EXPIRED → SETTLED (a late settlement); `settled_minor`,
 *   `settlement_transaction_id` and `resolved_at` are each set once. A trigger RAISEs on
 *   anything else; `fx_app` may UPDATE only those four columns and never DELETE.
 */
export class CreateReservations1790640000000 implements MigrationInterface {
  name = 'CreateReservations1790640000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE reservation_status AS ENUM ('ACTIVE', 'SETTLED', 'RELEASED', 'EXPIRED')`);
    await queryRunner.query(`
      CREATE TABLE reservations (
        id                         UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id                 UUID               NOT NULL REFERENCES accounts (id),
        flow_id                    UUID               NOT NULL,
        amount_minor               BIGINT             NOT NULL,
        settled_minor              BIGINT,
        settlement_transaction_id  UUID               REFERENCES transactions (id),
        status                     reservation_status NOT NULL DEFAULT 'ACTIVE',
        expires_at                 TIMESTAMPTZ        NOT NULL,
        created_at                 TIMESTAMPTZ        NOT NULL DEFAULT now(),
        resolved_at                TIMESTAMPTZ,

        CONSTRAINT reservations_amount_positive CHECK (amount_minor > 0),
        CONSTRAINT reservations_settled_positive CHECK (settled_minor > 0),
        CONSTRAINT reservations_resolved_unless_active CHECK ((status = 'ACTIVE') = (resolved_at IS NULL)),
        CONSTRAINT reservations_settlement_recorded_when_settled CHECK (
          (status = 'SETTLED') = (settled_minor IS NOT NULL)
          AND (status = 'SETTLED') = (settlement_transaction_id IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX reservations_active_account_index ON reservations (account_id) WHERE status = 'ACTIVE'
    `);
    await queryRunner.query(`
      CREATE INDEX reservations_active_expiry_index ON reservations (expires_at) WHERE status = 'ACTIVE'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX reservations_flow_account_unique ON reservations (flow_id, account_id)
    `);

    await queryRunner.query(`
      CREATE FUNCTION reservations_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'reservations are never deleted (attempted DELETE on id %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF (to_jsonb(NEW) - 'status' - 'settled_minor' - 'settlement_transaction_id' - 'resolved_at')
           IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'settled_minor' - 'settlement_transaction_id' - 'resolved_at') THEN
          RAISE EXCEPTION 'reservation % is immutable apart from its resolution', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF NEW.status IS DISTINCT FROM OLD.status
           AND NOT (OLD.status = 'ACTIVE' AND NEW.status IN ('SETTLED', 'RELEASED', 'EXPIRED'))
           AND NOT (OLD.status = 'EXPIRED' AND NEW.status = 'SETTLED') THEN
          RAISE EXCEPTION 'reservation % cannot move from % to %', OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF (OLD.settled_minor IS NOT NULL AND NEW.settled_minor IS DISTINCT FROM OLD.settled_minor)
           OR (OLD.settlement_transaction_id IS NOT NULL
               AND NEW.settlement_transaction_id IS DISTINCT FROM OLD.settlement_transaction_id)
           OR (OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS DISTINCT FROM OLD.resolved_at) THEN
          RAISE EXCEPTION 'reservation % has already recorded its resolution', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER reservations_guard_mutation BEFORE UPDATE OR DELETE ON reservations
        FOR EACH ROW EXECUTE FUNCTION reservations_guard_mutation()
    `);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON reservations FROM fx_app`);
    await queryRunner.query(`
      GRANT UPDATE (status, settled_minor, settlement_transaction_id, resolved_at) ON reservations TO fx_app
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE reservations`);
    await queryRunner.query(`DROP FUNCTION reservations_guard_mutation()`);
    await queryRunner.query(`DROP TYPE reservation_status`);
  }
}
