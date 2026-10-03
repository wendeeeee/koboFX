import { MigrationInterface, QueryRunner } from 'typeorm';

const IMMUTABLE_TABLES = ['protected_provider_evidence', 'paystack_balance_observations', 'paystack_balance_ledger_rows'];

/**
 * Protected provider evidence (WITHDRAWAL_PLAN.md §D.1, §H; D6).
 *
 * - `protected_provider_evidence`: one raw provider response or raw webhook body, sealed (AES-256-GCM envelope:
 *   `sealed_content` = the codec's framed nonce ‖ ciphertext ‖ tag, `key_id` names the data key; the sealing code
 *   is W2's). Plaintext never reaches this table. `content_sha256` is the digest of the exact plaintext bytes, so a
 *   decrypted body can be proven to be what was received. No customer endpoint reads it.
 * - `paystack_balance_observations` / `paystack_balance_ledger_rows`: what `/balance` and `/balance/ledger` said,
 *   exact signed minor units, provider ids as text. A provider row whose content changed is a NEW row (a new
 *   `content_sha256`), contradictory evidence, never an UPDATE. Attribution lives in `withdrawal_accounting_events`.
 * - Everything here is evidence: UPDATE / DELETE / TRUNCATE raise for every role, superuser included; `fx_app`
 *   may SELECT and INSERT only. `environment` is fixed to `test` (live payouts are refused, D8).
 */
export class CreateProviderEvidence1791417600003 implements MigrationInterface {
  name = 'CreateProviderEvidence1791417600003';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE protected_provider_evidence (
        id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        provider          TEXT        NOT NULL,
        environment       TEXT        NOT NULL,
        operation         TEXT        NOT NULL,
        codec_version     SMALLINT    NOT NULL,
        key_id            TEXT        NOT NULL,
        sealed_content    BYTEA       NOT NULL,
        content_sha256    BYTEA       NOT NULL,
        content_length    INTEGER     NOT NULL,
        provider_call_id  BIGINT      REFERENCES provider_calls (id),
        webhook_event_id  UUID        REFERENCES webhook_events (id),
        received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT protected_provider_evidence_provider_valid CHECK (provider = 'paystack'),
        CONSTRAINT protected_provider_evidence_environment_test CHECK (environment = 'test'),
        CONSTRAINT protected_provider_evidence_operation_valid CHECK (operation ~ '^[a-z]+(\\.[a-z_]+)+$'),
        CONSTRAINT protected_provider_evidence_codec_positive CHECK (codec_version > 0),
        CONSTRAINT protected_provider_evidence_key_id_valid CHECK (key_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
        CONSTRAINT protected_provider_evidence_sealed_framed CHECK (octet_length(sealed_content) >= 29),
        CONSTRAINT protected_provider_evidence_digest_length CHECK (octet_length(content_sha256) = 32),
        CONSTRAINT protected_provider_evidence_length_non_negative CHECK (content_length >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE paystack_balance_observations (
        id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        provider_account_identity  TEXT        NOT NULL,
        environment                TEXT        NOT NULL,
        currency_code              CHAR(3)     NOT NULL REFERENCES currencies (code),
        balance_minor              BIGINT      NOT NULL,
        evidence_id                UUID        NOT NULL REFERENCES protected_provider_evidence (id),
        observed_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT paystack_balance_observations_identity_present CHECK (length(provider_account_identity) BETWEEN 1 AND 64),
        CONSTRAINT paystack_balance_observations_environment_test CHECK (environment = 'test')
      )
    `);

    await queryRunner.query(`
      CREATE TABLE paystack_balance_ledger_rows (
        id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        provider_account_identity  TEXT        NOT NULL,
        environment                TEXT        NOT NULL,
        provider_row_id            TEXT        NOT NULL,
        content_sha256             BYTEA       NOT NULL,
        currency_code              CHAR(3)     NOT NULL REFERENCES currencies (code),
        difference_minor           BIGINT      NOT NULL,
        balance_minor              BIGINT      NOT NULL,
        model_responsible          TEXT,
        model_row                  TEXT,
        provider_created_at        TIMESTAMPTZ,
        provider_updated_at        TIMESTAMPTZ,
        evidence_id                UUID        NOT NULL REFERENCES protected_provider_evidence (id),
        observed_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT paystack_balance_ledger_rows_identity_present CHECK (length(provider_account_identity) BETWEEN 1 AND 64),
        CONSTRAINT paystack_balance_ledger_rows_environment_test CHECK (environment = 'test'),
        CONSTRAINT paystack_balance_ledger_rows_row_id_digits CHECK (provider_row_id ~ '^[0-9]{1,30}$'),
        CONSTRAINT paystack_balance_ledger_rows_digest_length CHECK (octet_length(content_sha256) = 32),
        CONSTRAINT paystack_balance_ledger_rows_model_bounded CHECK (
          length(model_responsible) <= 64 AND length(model_row) <= 64
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX paystack_balance_ledger_rows_version_unique
        ON paystack_balance_ledger_rows (provider_account_identity, environment, provider_row_id, content_sha256)
    `);

    await queryRunner.query(`
      CREATE FUNCTION withdrawal_evidence_refuse_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only evidence (attempted %)', TG_TABLE_NAME, TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END $$ LANGUAGE plpgsql
    `);
    for (const table of IMMUTABLE_TABLES) {
      await queryRunner.query(`
        CREATE TRIGGER ${table}_refuse_mutation BEFORE UPDATE OR DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION withdrawal_evidence_refuse_mutation()
      `);
      await queryRunner.query(`
        CREATE TRIGGER ${table}_refuse_truncate BEFORE TRUNCATE ON ${table}
          FOR EACH STATEMENT EXECUTE FUNCTION withdrawal_evidence_refuse_mutation()
      `);
      await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON ${table} FROM fx_app`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [...IMMUTABLE_TABLES].reverse()) await queryRunner.query(`DROP TABLE ${table}`);
    await queryRunner.query(`DROP FUNCTION withdrawal_evidence_refuse_mutation()`);
  }
}
