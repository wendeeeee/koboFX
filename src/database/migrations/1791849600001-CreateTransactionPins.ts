import { MigrationInterface, QueryRunner } from 'typeorm';

/** Wrong PINs allowed before the PIN locks (until a reset with password + emailed code). */
export const TRANSACTION_PIN_MAXIMUM_ATTEMPTS = 5;

/**
 * `transaction_pins` (2026-10-12 decision): one PIN per user, the final confirmation of every withdrawal and conversion.
 *
 * - `pin_hash` is argon2id over an HMAC of the PIN under a server-side pepper (`TRANSACTION_PIN_PEPPER`): a leaked table
 *   alone cannot be brute-forced over the million possible PINs. The PIN itself is never stored.
 * - `failed_attempts` counts consecutive wrong PINs; reaching the maximum sets `locked_at` (CHECK-tied), and only a reset
 *   clears it. Counting happens in its own transaction, so a refused request cannot roll a wrong guess back.
 * - `user_id` and `set_at` never change (trigger); `fx_app` may INSERT and UPDATE the mutable columns only, never DELETE.
 */
export class CreateTransactionPins1791849600001 implements MigrationInterface {
  name = 'CreateTransactionPins1791849600001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE transaction_pins (
        user_id          UUID        PRIMARY KEY REFERENCES users (id),
        pin_hash         TEXT        NOT NULL,
        failed_attempts  INTEGER     NOT NULL DEFAULT 0,
        locked_at        TIMESTAMPTZ,
        set_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        changed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT transaction_pins_hash_argon2id CHECK (pin_hash LIKE '$argon2id$%'),
        CONSTRAINT transaction_pins_attempts_range CHECK (failed_attempts BETWEEN 0 AND ${TRANSACTION_PIN_MAXIMUM_ATTEMPTS}),
        CONSTRAINT transaction_pins_locked_when_exhausted CHECK ((locked_at IS NOT NULL) = (failed_attempts >= ${TRANSACTION_PIN_MAXIMUM_ATTEMPTS})),
        CONSTRAINT transaction_pins_changed_after_set CHECK (changed_at >= set_at)
      )
    `);
    await queryRunner.query(`
      CREATE FUNCTION transaction_pins_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'transaction PINs are never deleted (user %)', OLD.user_id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.set_at IS DISTINCT FROM OLD.set_at THEN
          RAISE EXCEPTION 'a transaction PIN''s owner and creation time never change (user %)', OLD.user_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER transaction_pins_guard_mutation BEFORE UPDATE OR DELETE ON transaction_pins
        FOR EACH ROW EXECUTE FUNCTION transaction_pins_guard_mutation()
    `);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON transaction_pins FROM fx_app`);
    await queryRunner.query(`GRANT UPDATE (pin_hash, failed_attempts, locked_at, changed_at) ON transaction_pins TO fx_app`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE transaction_pins`);
    await queryRunner.query(`DROP FUNCTION transaction_pins_guard_mutation()`);
  }
}
