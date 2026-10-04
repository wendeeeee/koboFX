import { MigrationInterface, QueryRunner } from 'typeorm';

const WEBHOOK_GUARD = (envelope: boolean) => `
      CREATE OR REPLACE FUNCTION webhook_events_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
          RAISE EXCEPTION 'webhook events are evidence and are never deleted'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.provider IS DISTINCT FROM OLD.provider
           OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id
           OR NEW.raw_payload IS DISTINCT FROM OLD.raw_payload OR NEW.headers IS DISTINCT FROM OLD.headers
           OR NEW.signature_valid IS DISTINCT FROM OLD.signature_valid
           OR NEW.received_at IS DISTINCT FROM OLD.received_at${
             envelope
               ? `
           OR NEW.payload_encoding IS DISTINCT FROM OLD.payload_encoding
           OR NEW.payload_key_id IS DISTINCT FROM OLD.payload_key_id
           OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256`
               : ''
           } THEN
          RAISE EXCEPTION 'webhook event % is evidence: what the provider sent is immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF (OLD.processed_at IS NOT NULL AND NEW.processed_at IS DISTINCT FROM OLD.processed_at)
           OR (OLD.outcome IS NOT NULL AND NEW.outcome IS DISTINCT FROM OLD.outcome) THEN
          RAISE EXCEPTION 'webhook event % has already been processed', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        RETURN NEW;
      END $$ LANGUAGE plpgsql`;

/**
 * Protected envelopes, W2 (WITHDRAWAL_PLAN.md §H, §I.1; D6).
 *
 * - `data_encryption_keys`: data keys (per user for destination PII, one for provider evidence), stored only WRAPPED
 *   (AES-256-GCM under a configured key-encryption key, named by `key_encryption_key_id`). The sealed financial facts
 *   name a data key by id and never change; rotating a key-encryption key rewraps THIS row (audited by the service),
 *   nothing else. Identity is immutable; only the wrapping moves, and `rewrapped_at` records when. No deletes.
 * - `webhook_events` gains its payload envelope: `PLAINTEXT_V1` (every existing row, and valid funding events) or
 *   `SEALED_V1` (transfer-bearing and refused Paystack deliveries): `raw_payload` then holds the sealed bytes,
 *   `payload_key_id` the data key, `payload_sha256` the digest of the EXACT signed bytes. Immutable like the payload.
 * - `idempotency_keys` gains `request_hash_algorithm` (`SHA256_V1`, every existing row; `HMAC_SHA256_V1` for requests
 *   whose body carries PII — a beneficiary's account number) and `request_hash_key_id`. A replay is checked with the
 *   row's own algorithm and key, forever.
 */
export class ProtectedEnvelopes1791504000000 implements MigrationInterface {
  name = 'ProtectedEnvelopes1791504000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE data_encryption_key_purpose AS ENUM ('USER_DESTINATION', 'PROVIDER_EVIDENCE')`);
    await queryRunner.query(`
      CREATE TABLE data_encryption_keys (
        id                      UUID                        PRIMARY KEY,
        purpose                 data_encryption_key_purpose NOT NULL,
        user_id                 UUID                        REFERENCES users (id),
        wrapped_key             BYTEA                       NOT NULL,
        key_encryption_key_id   TEXT                        NOT NULL,
        created_at              TIMESTAMPTZ                 NOT NULL DEFAULT now(),
        rewrapped_at            TIMESTAMPTZ,

        CONSTRAINT data_encryption_keys_owner_shape CHECK ((purpose = 'USER_DESTINATION') = (user_id IS NOT NULL)),
        CONSTRAINT data_encryption_keys_wrapped_framed CHECK (octet_length(wrapped_key) = 61),
        CONSTRAINT data_encryption_keys_key_id_valid CHECK (key_encryption_key_id ~ '^[A-Za-z0-9._:-]{1,64}$')
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX data_encryption_keys_user_unique ON data_encryption_keys (user_id) WHERE purpose = 'USER_DESTINATION'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX data_encryption_keys_evidence_unique ON data_encryption_keys (purpose) WHERE purpose = 'PROVIDER_EVIDENCE'
    `);
    await queryRunner.query(`
      CREATE INDEX data_encryption_keys_wrapping_index ON data_encryption_keys (key_encryption_key_id)
    `);
    await queryRunner.query(`
      CREATE FUNCTION data_encryption_keys_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
          RAISE EXCEPTION 'data encryption keys are never deleted: sealed facts depend on them'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (NEW.id, NEW.purpose, NEW.user_id, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.purpose, OLD.user_id, OLD.created_at) THEN
          RAISE EXCEPTION 'data encryption key % identity is immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.wrapped_key IS DISTINCT FROM OLD.wrapped_key
           AND (NEW.rewrapped_at IS NULL OR NEW.rewrapped_at IS NOT DISTINCT FROM OLD.rewrapped_at) THEN
          RAISE EXCEPTION 'data encryption key % rewrapped without recording when', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER data_encryption_keys_guard_mutation BEFORE UPDATE OR DELETE ON data_encryption_keys
        FOR EACH ROW EXECUTE FUNCTION data_encryption_keys_guard_mutation()
    `);
    await queryRunner.query(`
      CREATE TRIGGER data_encryption_keys_refuse_truncate BEFORE TRUNCATE ON data_encryption_keys
        FOR EACH STATEMENT EXECUTE FUNCTION data_encryption_keys_guard_mutation()
    `);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON data_encryption_keys FROM fx_app`);
    await queryRunner.query(`GRANT UPDATE (wrapped_key, key_encryption_key_id, rewrapped_at) ON data_encryption_keys TO fx_app`);

    await queryRunner.query(`
      ALTER TABLE webhook_events
        ADD COLUMN payload_encoding TEXT NOT NULL DEFAULT 'PLAINTEXT_V1',
        ADD COLUMN payload_key_id   TEXT,
        ADD COLUMN payload_sha256   BYTEA,
        ADD CONSTRAINT webhook_events_payload_encoding_valid CHECK (payload_encoding IN ('PLAINTEXT_V1', 'SEALED_V1')),
        ADD CONSTRAINT webhook_events_payload_envelope_shape CHECK (
          (payload_encoding = 'SEALED_V1') = (payload_key_id IS NOT NULL)
          AND (payload_encoding = 'SEALED_V1') = (payload_sha256 IS NOT NULL)
          AND (payload_sha256 IS NULL OR octet_length(payload_sha256) = 32)
        )
    `);
    await queryRunner.query(WEBHOOK_GUARD(true));

    await queryRunner.query(`
      ALTER TABLE idempotency_keys
        ADD COLUMN request_hash_algorithm TEXT NOT NULL DEFAULT 'SHA256_V1',
        ADD COLUMN request_hash_key_id    TEXT,
        ADD CONSTRAINT idempotency_keys_request_hash_algorithm_valid CHECK (request_hash_algorithm IN ('SHA256_V1', 'HMAC_SHA256_V1')),
        ADD CONSTRAINT idempotency_keys_request_hash_key_shape CHECK (
          (request_hash_algorithm = 'HMAC_SHA256_V1') = (request_hash_key_id IS NOT NULL)
        )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE idempotency_keys
        DROP CONSTRAINT idempotency_keys_request_hash_key_shape,
        DROP CONSTRAINT idempotency_keys_request_hash_algorithm_valid,
        DROP COLUMN request_hash_key_id,
        DROP COLUMN request_hash_algorithm
    `);
    await queryRunner.query(WEBHOOK_GUARD(false));
    await queryRunner.query(`
      ALTER TABLE webhook_events
        DROP CONSTRAINT webhook_events_payload_envelope_shape,
        DROP CONSTRAINT webhook_events_payload_encoding_valid,
        DROP COLUMN payload_sha256,
        DROP COLUMN payload_key_id,
        DROP COLUMN payload_encoding
    `);
    await queryRunner.query(`DROP TABLE data_encryption_keys`);
    await queryRunner.query(`DROP FUNCTION data_encryption_keys_guard_mutation()`);
    await queryRunner.query(`DROP TYPE data_encryption_key_purpose`);
  }
}
