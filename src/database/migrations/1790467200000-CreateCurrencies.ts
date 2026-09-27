import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The controlled currency set (design §4.2) plus a shared `updated_at` trigger.
 *
 * `minor_unit` is read by the application for every conversion between minor and
 * major units — it is never hardcoded. ISO 4217 minor units range 0–4.
 * `currencies.code` is an opaque key so a future (network, contract) identifier for
 * crypto is a table change, not a rewrite.
 */
export class CreateCurrencies1790467200000 implements MigrationInterface {
  name = 'CreateCurrencies1790467200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
      BEGIN
        NEW.updated_at := now();
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TABLE currencies (
        code        CHAR(3)     PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
        name        TEXT        NOT NULL,
        symbol      TEXT        NOT NULL,
        minor_unit  SMALLINT    NOT NULL CHECK (minor_unit BETWEEN 0 AND 4),
        is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TRIGGER currencies_set_updated_at BEFORE UPDATE ON currencies
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);

    await queryRunner.query(`
      INSERT INTO currencies (code, name, symbol, minor_unit) VALUES
        ('NGN', 'Nigerian Naira', '₦', 2),
        ('USD', 'US Dollar',      '$', 2),
        ('EUR', 'Euro',           '€', 2),
        ('GBP', 'Pound Sterling', '£', 2)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE currencies`);
    await queryRunner.query(`DROP FUNCTION set_updated_at()`);
  }
}
