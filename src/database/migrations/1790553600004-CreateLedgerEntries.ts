import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `ledger_entries` (design §5.5): immutable, tamper-evident. Immutability three ways:
 *
 * 1. By construction — `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` triggers that
 *    RAISE. Never a silent RULE.
 * 2. By permission — `fx_app` has no UPDATE, DELETE or TRUNCATE.
 * 3. Post-factum — a per-account hash chain, computed HERE at insert by a trigger
 *    (the application cannot forget it or get it wrong), and recomputed by the
 *    verifier from the stored row alone, through the same SQL functions.
 *
 * Canonical form (version tag `v1`), fields joined with `|`:
 *   v1 | id | account_id | transaction_id | currency_code | direction | amount_minor
 *      | balance_after_minor | value_time | booking_time
 * Timestamps are integer epoch MICROSECONDS — exact in Postgres, and immune to the
 * JS millisecond `Date` precision mismatch.
 *   entry_hash = sha256(coalesce(previous_hash, '') || utf8(canonical))
 *
 * The insert trigger also takes the account row lock (a no-op when the posting
 * already holds it), so the chain is serialized per account even for an insert that
 * bypasses LedgerService, and it refuses an entry whose currency differs from its
 * account's.
 */
export class CreateLedgerEntries1790553600004 implements MigrationInterface {
  name = 'CreateLedgerEntries1790553600004';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE ledger_entries (
        id                   BIGINT          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        transaction_id       UUID            NOT NULL REFERENCES transactions (id),
        account_id           UUID            NOT NULL REFERENCES accounts (id),
        currency_code        CHAR(3)         NOT NULL REFERENCES currencies (code),
        direction            entry_direction NOT NULL,
        amount_minor         BIGINT          NOT NULL CHECK (amount_minor > 0),
        balance_after_minor  BIGINT          NOT NULL,
        value_time           TIMESTAMPTZ     NOT NULL,
        booking_time         TIMESTAMPTZ     NOT NULL DEFAULT now(),
        previous_hash        BYTEA,
        entry_hash           BYTEA           NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX ledger_entries_account_id_index ON ledger_entries (account_id, id DESC)`);
    await queryRunner.query(`CREATE INDEX ledger_entries_transaction_id_index ON ledger_entries (transaction_id)`);

    await queryRunner.query(`
      CREATE FUNCTION ledger_entry_canonical_text(
        entry_id            BIGINT,
        account_id          UUID,
        transaction_id      UUID,
        currency_code       CHAR(3),
        direction           entry_direction,
        amount_minor        BIGINT,
        balance_after_minor BIGINT,
        value_time          TIMESTAMPTZ,
        booking_time        TIMESTAMPTZ
      ) RETURNS TEXT
      LANGUAGE sql IMMUTABLE STRICT
      AS $$
        SELECT 'v1'
          || '|' || entry_id::text
          || '|' || account_id::text
          || '|' || transaction_id::text
          || '|' || currency_code::text
          || '|' || direction::text
          || '|' || amount_minor::text
          || '|' || balance_after_minor::text
          || '|' || (extract(epoch FROM value_time) * 1000000)::bigint::text
          || '|' || (extract(epoch FROM booking_time) * 1000000)::bigint::text
      $$
    `);
    await queryRunner.query(`
      CREATE FUNCTION ledger_entry_hash(previous_hash BYTEA, canonical_text TEXT) RETURNS BYTEA
      LANGUAGE sql STABLE
      AS $$
        SELECT sha256(coalesce(previous_hash, ''::bytea) || convert_to(canonical_text, 'UTF8'))
      $$
    `);

    await queryRunner.query(`
      CREATE FUNCTION ledger_entries_chain_on_insert() RETURNS trigger AS $$
      DECLARE
        account_currency CHAR(3);
        last_entry_hash  BYTEA;
      BEGIN
        SELECT currency_code INTO account_currency FROM accounts WHERE id = NEW.account_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'ledger entry references unknown account %', NEW.account_id
            USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF account_currency <> NEW.currency_code THEN
          RAISE EXCEPTION 'ledger entry currency % differs from account % currency %',
            NEW.currency_code, NEW.account_id, account_currency
            USING ERRCODE = 'check_violation';
        END IF;

        SELECT entry_hash INTO last_entry_hash
          FROM ledger_entries
         WHERE account_id = NEW.account_id
         ORDER BY id DESC
         LIMIT 1;

        NEW.previous_hash := last_entry_hash;
        NEW.entry_hash := ledger_entry_hash(
          last_entry_hash,
          ledger_entry_canonical_text(
            NEW.id, NEW.account_id, NEW.transaction_id, NEW.currency_code, NEW.direction,
            NEW.amount_minor, NEW.balance_after_minor, NEW.value_time, NEW.booking_time));
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER ledger_entries_hash_chain BEFORE INSERT ON ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_entries_chain_on_insert()
    `);

    await queryRunner.query(`
      CREATE FUNCTION ledger_entries_reject_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_LEVEL = 'STATEMENT' THEN
          RAISE EXCEPTION 'ledger_entries is append-only (attempted %)', TG_OP
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RAISE EXCEPTION 'ledger_entries is append-only (attempted % on id %)', TG_OP, OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER ledger_entries_no_mutation BEFORE UPDATE OR DELETE ON ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_entries_reject_mutation()
    `);
    await queryRunner.query(`
      CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_reject_mutation()
    `);

    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries FROM fx_app`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE ledger_entries`);
    await queryRunner.query(`DROP FUNCTION ledger_entries_reject_mutation()`);
    await queryRunner.query(`DROP FUNCTION ledger_entries_chain_on_insert()`);
    await queryRunner.query(`DROP FUNCTION ledger_entry_hash(BYTEA, TEXT)`);
    await queryRunner.query(`
      DROP FUNCTION ledger_entry_canonical_text(
        BIGINT, UUID, UUID, CHAR(3), entry_direction, BIGINT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ)
    `);
  }
}
