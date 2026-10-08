import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Corrections of an internal transaction (Phase 10 plan §A.1, option B).
 *
 * ONE `SETTLEMENT` posting books every unattributed line of a batch to `CLEARING`, so a batch with two
 * such lines needs two corrections of the same original. Chaining them ("correct the correction") would
 * link one user's correction to another user's. Instead:
 *
 * - `transactions.correction_subject`: which part of an INTERNAL original (`user_id IS NULL`) a CORRECTION
 *   corrects, e.g. `line:{settlementBatchLineId}`. Only on internal originals (trigger); without one, an original is
 *   corrected at most once, as always — the unique index is now on `(corrects_transaction_id, COALESCE(subject, ''))`.
 * - A subject-scoped correction leaves the original's `corrected_by_transaction_id` unset (it holds one id);
 *   the reverse link lives on what was corrected: `settlement_line_corrections` (append-only evidence — the
 *   line itself is immutable), one row per corrected line, naming the correction and its approval.
 * - `PSP_PAYABLE` (LIABILITY, CREDIT-normal): money the PSP paid us twice, owed back (a duplicate line).
 */
export class CorrectionSubjects1791244800005 implements MigrationInterface {
  name = 'CorrectionSubjects1791244800005';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE transactions
        ADD COLUMN correction_subject TEXT,
        ADD CONSTRAINT transactions_correction_subject_format CHECK (correction_subject ~ '^[a-z][a-z-]*:.+$'),
        ADD CONSTRAINT transactions_correction_subject_only_on_corrections CHECK (correction_subject IS NULL OR type = 'CORRECTION')
    `);
    await queryRunner.query(`DROP INDEX transactions_corrects_transaction_id_unique`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX transactions_corrects_transaction_subject_unique
        ON transactions (corrects_transaction_id, (COALESCE(correction_subject, '')))
        WHERE corrects_transaction_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE FUNCTION transactions_check_correction_subject() RETURNS trigger AS $$
      DECLARE
        original_is_internal BOOLEAN;
      BEGIN
        IF NEW.corrects_transaction_id IS NULL THEN
          RETURN NEW;
        END IF;
        SELECT user_id IS NULL INTO original_is_internal FROM transactions WHERE id = NEW.corrects_transaction_id;
        IF NEW.correction_subject IS NOT NULL AND NOT original_is_internal THEN
          RAISE EXCEPTION 'only a correction of an internal transaction names a subject'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER transactions_check_correction_subject BEFORE INSERT ON transactions
        FOR EACH ROW EXECUTE FUNCTION transactions_check_correction_subject()
    `);

    await queryRunner.query(`
      CREATE TABLE settlement_line_corrections (
        settlement_batch_line_id  UUID        PRIMARY KEY REFERENCES settlement_batch_lines (id),
        transaction_id            UUID        NOT NULL UNIQUE REFERENCES transactions (id),
        approval_id               UUID        NOT NULL UNIQUE REFERENCES approvals (id),
        recorded_at               TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TRIGGER settlement_line_corrections_refuse_mutation BEFORE UPDATE OR DELETE ON settlement_line_corrections
        FOR EACH ROW EXECUTE FUNCTION settlement_evidence_refuse_mutation()
    `);
    await queryRunner.query(`
      CREATE TRIGGER settlement_line_corrections_refuse_truncate BEFORE TRUNCATE ON settlement_line_corrections
        FOR EACH STATEMENT EXECUTE FUNCTION settlement_evidence_refuse_mutation()
    `);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON settlement_line_corrections FROM fx_app`);

    await queryRunner.query(`
      INSERT INTO system_account_templates (name, account_type, normal_side, description)
        VALUES ('PSP_PAYABLE', 'LIABILITY', 'CREDIT', 'Money the PSP paid us that we owe back (a duplicated settlement)')
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE settlement_line_corrections`);
    await queryRunner.query(`DROP TRIGGER transactions_check_correction_subject ON transactions`);
    await queryRunner.query(`DROP FUNCTION transactions_check_correction_subject()`);
    await queryRunner.query(`DROP INDEX transactions_corrects_transaction_subject_unique`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX transactions_corrects_transaction_id_unique
        ON transactions (corrects_transaction_id) WHERE corrects_transaction_id IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE transactions
        DROP CONSTRAINT transactions_correction_subject_only_on_corrections,
        DROP CONSTRAINT transactions_correction_subject_format,
        DROP COLUMN correction_subject
    `);
  }
}
