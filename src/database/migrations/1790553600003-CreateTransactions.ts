import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `transactions` (design §5.4), with full names in place of the design's
 * abbreviations: `corrects_transaction_id`, `corrected_by_transaction_id`,
 * `spread_basis_points`, `external_reference`.
 *
 * - `quote_id` has NO foreign key yet: Phase 6 adds `REFERENCES quotes(id)` when it
 *   creates `quotes` (binding decision, CLAUDE.md 2026-09-28).
 * - Rows are append-only except for exactly two transitions (decision 2026-09-28):
 *   `corrected_by_transaction_id` set once from NULL, and `status` POSTED → REVERSED.
 *   Anything else RAISEs; it never silently no-ops.
 * - An original is corrected at most once — by construction, via a partial unique
 *   index on `corrects_transaction_id`.
 */
export class CreateTransactions1790553600003 implements MigrationInterface {
  name = 'CreateTransactions1790553600003';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE transactions (
        id                           UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
        reference                    TEXT               NOT NULL UNIQUE,
        user_id                      UUID               REFERENCES users (id),
        type                         transaction_type   NOT NULL,
        status                       transaction_status NOT NULL,

        source_currency              CHAR(3)            REFERENCES currencies (code),
        source_amount_minor          BIGINT,
        target_currency              CHAR(3)            REFERENCES currencies (code),
        target_amount_minor          BIGINT,

        rate_display                 NUMERIC(24, 12),
        reference_rate               NUMERIC(24, 12),
        rate_provider                TEXT,
        rate_fetched_at              TIMESTAMPTZ,
        spread_basis_points          INTEGER,
        quote_id                     UUID,

        value_time                   TIMESTAMPTZ        NOT NULL,
        booking_time                 TIMESTAMPTZ        NOT NULL DEFAULT now(),
        settlement_time              TIMESTAMPTZ,

        initiated_by                 TEXT               NOT NULL
          CHECK (initiated_by ~ '^(user|operator|job):.+$'),
        reason_code                  TEXT,
        corrects_transaction_id      UUID               REFERENCES transactions (id),
        corrected_by_transaction_id  UUID               REFERENCES transactions (id),

        idempotency_key              TEXT,
        external_reference           TEXT,
        failure_code                 TEXT,
        metadata                     JSONB              NOT NULL DEFAULT '{}',

        CONSTRAINT transactions_does_not_correct_itself CHECK (corrects_transaction_id <> id),
        CONSTRAINT transactions_correction_types_link_an_original CHECK (
          (type IN ('REVERSAL', 'CORRECTION')) = (corrects_transaction_id IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX transactions_user_value_time_index ON transactions (user_id, value_time DESC, id DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX transactions_external_reference_index
        ON transactions (external_reference) WHERE external_reference IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX transactions_corrects_transaction_id_unique
        ON transactions (corrects_transaction_id) WHERE corrects_transaction_id IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE FUNCTION transactions_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'transactions are never deleted (attempted DELETE on id %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF (to_jsonb(NEW) - 'corrected_by_transaction_id' - 'status')
           IS DISTINCT FROM (to_jsonb(OLD) - 'corrected_by_transaction_id' - 'status') THEN
          RAISE EXCEPTION 'transaction % is immutable apart from its correction link and reversal status', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF NEW.corrected_by_transaction_id IS DISTINCT FROM OLD.corrected_by_transaction_id
           AND OLD.corrected_by_transaction_id IS NOT NULL THEN
          RAISE EXCEPTION 'transaction % is already corrected by %', OLD.id, OLD.corrected_by_transaction_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF NEW.status IS DISTINCT FROM OLD.status
           AND NOT (OLD.status = 'POSTED' AND NEW.status = 'REVERSED') THEN
          RAISE EXCEPTION 'transaction % cannot move from % to %', OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER transactions_guard_mutation BEFORE UPDATE OR DELETE ON transactions
        FOR EACH ROW EXECUTE FUNCTION transactions_guard_mutation()
    `);
    await queryRunner.query(`REVOKE DELETE, TRUNCATE ON transactions FROM fx_app`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE transactions`);
    await queryRunner.query(`DROP FUNCTION transactions_guard_mutation()`);
  }
}
