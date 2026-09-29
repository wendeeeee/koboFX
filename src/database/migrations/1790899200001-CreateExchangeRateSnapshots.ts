import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `exchange_rate_snapshots` + `exchange_rate_snapshot_rates` (design §4.3, §7.4: the
 * design's `fx_rate_snapshots`, renamed under the no-abbreviations rule).
 *
 * One snapshot row per fetch that produced a response we could read, ACCEPTED or
 * REJECTED (a rejected fetch is evidence, never served). There is no canonical rate
 * (handbook), so the provider, the provider's own publication times and our fetch time
 * are part of every row. The response itself — every digit — is in `provider_calls`,
 * linked by `provider_call_id`.
 *
 * Rates are `NUMERIC` without a typmod: exact at any scale, so the provider's digits
 * survive the round trip (a triangulated NGN→USD mid would keep ~9 significant digits
 * in `NUMERIC(24,12)`). One child row per currency in our `currencies` table that the
 * response carried; USD-based mids (`1 USD = rate × currency`).
 *
 * Evidence: UPDATE, DELETE and TRUNCATE raise on both tables — for a superuser too.
 */
export class CreateExchangeRateSnapshots1790899200001 implements MigrationInterface {
  name = 'CreateExchangeRateSnapshots1790899200001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE exchange_rate_snapshot_status AS ENUM ('ACCEPTED', 'REJECTED')`);
    await queryRunner.query(`
      CREATE TABLE exchange_rate_snapshots (
        id                       UUID                          PRIMARY KEY DEFAULT gen_random_uuid(),
        provider                 TEXT                          NOT NULL,
        base_currency_code       CHAR(3)                       NOT NULL,
        provider_updated_at      TIMESTAMPTZ,
        provider_next_update_at  TIMESTAMPTZ,
        fetched_at               TIMESTAMPTZ                   NOT NULL,
        status                   exchange_rate_snapshot_status NOT NULL,
        rejection_reasons        TEXT[]                        NOT NULL DEFAULT '{}',
        provider_call_id         BIGINT                        REFERENCES provider_calls (id),
        recorded_at              TIMESTAMPTZ                   NOT NULL DEFAULT now(),

        CONSTRAINT exchange_rate_snapshots_reasons_iff_rejected
          CHECK ((status = 'REJECTED') = (cardinality(rejection_reasons) > 0)),
        CONSTRAINT exchange_rate_snapshots_accepted_has_times CHECK (
          status = 'REJECTED' OR (provider_updated_at IS NOT NULL AND provider_next_update_at IS NOT NULL)
        ),
        CONSTRAINT exchange_rate_snapshots_accepted_base_is_usd CHECK (status = 'REJECTED' OR base_currency_code = 'USD')
      )
    `);
    await queryRunner.query(`
      CREATE INDEX exchange_rate_snapshots_latest_accepted_index
        ON exchange_rate_snapshots (provider, fetched_at DESC, id DESC) WHERE status = 'ACCEPTED'
    `);
    await queryRunner.query(`
      CREATE TABLE exchange_rate_snapshot_rates (
        snapshot_id    UUID    NOT NULL REFERENCES exchange_rate_snapshots (id),
        currency_code  CHAR(3) NOT NULL REFERENCES currencies (code),
        rate           NUMERIC NOT NULL,
        PRIMARY KEY (snapshot_id, currency_code)
      )
    `);

    // A rejected snapshot keeps whatever the provider sent (a zero is the evidence); an
    // accepted one may only hold positive rates. Deferred: the parent row is inserted first.
    await queryRunner.query(`
      CREATE FUNCTION exchange_rate_snapshot_rates_check_accepted() RETURNS trigger AS $$
      BEGIN
        IF NEW.rate <= 0 AND EXISTS (
             SELECT 1 FROM exchange_rate_snapshots WHERE id = NEW.snapshot_id AND status = 'ACCEPTED') THEN
          RAISE EXCEPTION 'an accepted exchange rate snapshot may only hold positive rates (% = %)', NEW.currency_code, NEW.rate
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER exchange_rate_snapshot_rates_check_accepted
        AFTER INSERT ON exchange_rate_snapshot_rates DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION exchange_rate_snapshot_rates_check_accepted()
    `);

    await queryRunner.query(`
      CREATE FUNCTION exchange_rate_snapshots_refuse_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'exchange rate snapshots are append-only evidence (attempted % on %)', TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'integrity_constraint_violation';
      END $$ LANGUAGE plpgsql
    `);
    for (const table of ['exchange_rate_snapshots', 'exchange_rate_snapshot_rates']) {
      await queryRunner.query(`
        CREATE TRIGGER ${table}_refuse_mutation BEFORE UPDATE OR DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION exchange_rate_snapshots_refuse_mutation()
      `);
      await queryRunner.query(`
        CREATE TRIGGER ${table}_refuse_truncate BEFORE TRUNCATE ON ${table}
          FOR EACH STATEMENT EXECUTE FUNCTION exchange_rate_snapshots_refuse_mutation()
      `);
      await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON ${table} FROM fx_app`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE exchange_rate_snapshot_rates`);
    await queryRunner.query(`DROP TABLE exchange_rate_snapshots`);
    await queryRunner.query(`DROP FUNCTION exchange_rate_snapshots_refuse_mutation()`);
    await queryRunner.query(`DROP FUNCTION exchange_rate_snapshot_rates_check_accepted()`);
    await queryRunner.query(`DROP TYPE exchange_rate_snapshot_status`);
  }
}
