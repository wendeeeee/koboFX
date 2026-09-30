import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PSP settlement reports (Phase 9; design §8.2, handbook Appendix B Flow 2 step 5). Not in
 * the design; approved as a gap fill.
 *
 * - `settlement_batches` — one row per PSP batch id, ingested in ONE transaction with its
 *   lines and (when the report adds up) its settlement posting. `POSTED` or `REJECTED`
 *   (the report was refused: nothing posted, a break escalated). Identity and amounts are
 *   immutable; nothing else changes after insert either.
 * - `settlement_batch_lines` — what the PSP says each line of a POSTED batch settled: a payment
 *   (gross + the PSP's fee) or a chargeback deduction (amount + fee). `attribution` says where
 *   the line's money went: `ATTRIBUTED` (a deposit of ours, `PSP_RECEIVABLE`) or `CLEARING`
 *   (money we cannot attribute). A rejected batch stores no lines — its evidence is the raw
 *   report in `provider_calls`. A deposit is settled at most once BY CONSTRUCTION (partial
 *   unique on the attributed payment id). Immutable.
 * - `settlement_report_versions` — evidence: every distinct content read for a batch (the
 *   canonical content hash + the `provider_calls` rows holding the raw text). A report that
 *   changes after we read it is a second version, never an edit. Immutable and
 *   untruncatable for a superuser too, like `provider_calls`.
 *
 * `fx_app` may SELECT and INSERT these tables, and nothing else.
 */
export class CreateSettlementBatches1791158400001 implements MigrationInterface {
  name = 'CreateSettlementBatches1791158400001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE settlement_batch_status AS ENUM ('POSTED', 'REJECTED')`);
    await queryRunner.query(`CREATE TYPE settlement_line_type AS ENUM ('PAYMENT', 'CHARGEBACK')`);
    await queryRunner.query(`CREATE TYPE settlement_line_attribution AS ENUM ('ATTRIBUTED', 'CLEARING')`);

    await queryRunner.query(`
      CREATE TABLE settlement_batches (
        id                         UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),
        provider                   TEXT                    NOT NULL,
        provider_batch_id          TEXT                    NOT NULL,
        -- What the PSP said, even in a currency we do not hold (then REJECTED): no foreign key.
        currency_code              CHAR(3)                 NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
        settled_at                 TIMESTAMPTZ             NOT NULL,
        gross_minor                BIGINT                  NOT NULL,
        fee_minor                  BIGINT                  NOT NULL,
        chargeback_minor           BIGINT                  NOT NULL,
        net_minor                  BIGINT                  NOT NULL,
        line_count                 INTEGER                 NOT NULL,
        content_hash               CHAR(64)                NOT NULL,
        status                     settlement_batch_status NOT NULL,
        rejection_code             TEXT,
        settlement_transaction_id  UUID                    UNIQUE REFERENCES transactions (id),
        first_seen_at              TIMESTAMPTZ             NOT NULL DEFAULT now(),

        CONSTRAINT settlement_batches_provider_batch_unique UNIQUE (provider, provider_batch_id),
        CONSTRAINT settlement_batches_amounts_non_negative
          CHECK (gross_minor >= 0 AND fee_minor >= 0 AND chargeback_minor >= 0 AND line_count >= 0),
        CONSTRAINT settlement_batches_content_hash_hex CHECK (content_hash ~ '^[0-9a-f]{64}$'),
        -- Every column spelled out IS NOT NULL: a CHECK passes when it evaluates to NULL.
        CONSTRAINT settlement_batches_posted_complete CHECK (
          status <> 'POSTED' OR (
            settlement_transaction_id IS NOT NULL AND rejection_code IS NULL
            AND net_minor = gross_minor - fee_minor - chargeback_minor
          )
        ),
        CONSTRAINT settlement_batches_rejected_explained CHECK (
          status <> 'REJECTED' OR (rejection_code IS NOT NULL AND settlement_transaction_id IS NULL)
        )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE settlement_batch_lines (
        id                      UUID                         PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_id                UUID                         NOT NULL REFERENCES settlement_batches (id),
        provider                TEXT                         NOT NULL,
        provider_line_id        TEXT                         NOT NULL,
        line_type               settlement_line_type         NOT NULL,
        provider_payment_id     TEXT                         NOT NULL,
        provider_chargeback_id  TEXT,
        amount_minor            BIGINT                       NOT NULL,
        fee_minor               BIGINT                       NOT NULL,
        flow_id                 UUID                         REFERENCES flow_instances (id),
        attribution             settlement_line_attribution  NOT NULL,

        CONSTRAINT settlement_batch_lines_line_unique UNIQUE (batch_id, provider_line_id),
        CONSTRAINT settlement_batch_lines_amount_positive CHECK (amount_minor > 0),
        CONSTRAINT settlement_batch_lines_fee_non_negative CHECK (fee_minor >= 0),
        CONSTRAINT settlement_batch_lines_chargeback_identified CHECK (
          (line_type = 'CHARGEBACK') = (provider_chargeback_id IS NOT NULL)
        ),
        CONSTRAINT settlement_batch_lines_attributed_to_a_flow CHECK (
          attribution <> 'ATTRIBUTED' OR flow_id IS NOT NULL
        )
      )
    `);
    await queryRunner.query(`CREATE INDEX settlement_batch_lines_batch_index ON settlement_batch_lines (batch_id)`);
    await queryRunner.query(
      `CREATE INDEX settlement_batch_lines_payment_index ON settlement_batch_lines (provider, provider_payment_id)`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX settlement_batch_lines_payment_settled_once
        ON settlement_batch_lines (provider, provider_payment_id)
        WHERE line_type = 'PAYMENT' AND attribution = 'ATTRIBUTED'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX settlement_batch_lines_chargeback_deducted_once
        ON settlement_batch_lines (provider, provider_chargeback_id)
        WHERE line_type = 'CHARGEBACK' AND attribution = 'ATTRIBUTED'
    `);

    await queryRunner.query(`
      CREATE TABLE settlement_report_versions (
        id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_id           UUID        NOT NULL REFERENCES settlement_batches (id),
        content_hash       CHAR(64)    NOT NULL,
        provider_call_ids  BIGINT[]    NOT NULL,
        observed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT settlement_report_versions_content_unique UNIQUE (batch_id, content_hash),
        CONSTRAINT settlement_report_versions_content_hash_hex CHECK (content_hash ~ '^[0-9a-f]{64}$')
      )
    `);

    await queryRunner.query(`
      CREATE FUNCTION settlement_evidence_refuse_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only settlement evidence (attempted %)', TG_TABLE_NAME, TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END $$ LANGUAGE plpgsql
    `);
    for (const table of ['settlement_batches', 'settlement_batch_lines', 'settlement_report_versions']) {
      await queryRunner.query(`
        CREATE TRIGGER ${table}_refuse_mutation BEFORE UPDATE OR DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION settlement_evidence_refuse_mutation()
      `);
      await queryRunner.query(`
        CREATE TRIGGER ${table}_refuse_truncate BEFORE TRUNCATE ON ${table}
          FOR EACH STATEMENT EXECUTE FUNCTION settlement_evidence_refuse_mutation()
      `);
      await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON ${table} FROM fx_app`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE settlement_report_versions`);
    await queryRunner.query(`DROP TABLE settlement_batch_lines`);
    await queryRunner.query(`DROP TABLE settlement_batches`);
    await queryRunner.query(`DROP FUNCTION settlement_evidence_refuse_mutation()`);
    await queryRunner.query(`DROP TYPE settlement_line_attribution`);
    await queryRunner.query(`DROP TYPE settlement_line_type`);
    await queryRunner.query(`DROP TYPE settlement_batch_status`);
  }
}
