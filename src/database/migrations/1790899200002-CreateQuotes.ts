import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `quotes` (design §7.7, §15 item 9; shape is a Phase 6 decision): a directional,
 * single-use, non-transferable price, valid for the quote time to live.
 *
 * A quote locks everything Phase 7 posts, so a trade never re-prices: the source amount
 * the user sells, the target amount credited (`ROUND_DOWN`), the mid value of the source
 * in the target currency (`ROUND_HALF_EVEN`) and the revenue as their difference (§5.6)
 * — plus the provenance of the reference rate (provider, the snapshot, its times, both
 * USD mids) because there is no canonical rate.
 *
 * Every column is immutable except `consumed_at`, set once NULL → value, strictly before
 * `expires_at` (so "consumed" and "expired" can never both be true). `fx_app` may UPDATE
 * `consumed_at` only and never DELETE.
 *
 * Also, per the Phase 2 decision, `transactions.quote_id` gets its foreign key here; and
 * `transactions.rate_display` / `reference_rate` widen from `NUMERIC(24,12)` to exact
 * `NUMERIC` so a triangulated reference mid is stored as priced (Phase 6 decision A.4).
 */
export class CreateQuotes1790899200002 implements MigrationInterface {
  name = 'CreateQuotes1790899200002';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE quote_amount_mode AS ENUM ('SOURCE', 'TARGET')`);
    await queryRunner.query(`
      CREATE TABLE quotes (
        id                        UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id                   UUID              NOT NULL REFERENCES users (id),
        source_currency_code      CHAR(3)           NOT NULL,
        target_currency_code      CHAR(3)           NOT NULL,
        amount_mode               quote_amount_mode NOT NULL,
        source_amount_minor       BIGINT            NOT NULL,
        target_amount_minor       BIGINT            NOT NULL,
        target_mid_value_minor    BIGINT            NOT NULL,
        revenue_minor             BIGINT            NOT NULL,
        mid_rate                  NUMERIC           NOT NULL,
        client_rate               NUMERIC           NOT NULL,
        spread_basis_points       INTEGER           NOT NULL,
        source_reference_rate     NUMERIC           NOT NULL,
        target_reference_rate     NUMERIC           NOT NULL,
        rate_snapshot_id          UUID              NOT NULL REFERENCES exchange_rate_snapshots (id),
        rate_provider             TEXT              NOT NULL,
        rate_provider_updated_at  TIMESTAMPTZ       NOT NULL,
        rate_fetched_at           TIMESTAMPTZ       NOT NULL,
        issued_at                 TIMESTAMPTZ       NOT NULL,
        expires_at                TIMESTAMPTZ       NOT NULL,
        consumed_at               TIMESTAMPTZ,
        recorded_at               TIMESTAMPTZ       NOT NULL DEFAULT now(),

        FOREIGN KEY (source_currency_code, target_currency_code)
          REFERENCES currency_pairs (source_currency_code, target_currency_code),
        CONSTRAINT quotes_amounts_positive CHECK (
          source_amount_minor > 0 AND target_amount_minor > 0 AND target_mid_value_minor > 0
        ),
        CONSTRAINT quotes_revenue_is_the_difference CHECK (
          revenue_minor >= 0 AND revenue_minor = target_mid_value_minor - target_amount_minor
        ),
        CONSTRAINT quotes_rates_positive CHECK (
          mid_rate > 0 AND client_rate > 0 AND source_reference_rate > 0 AND target_reference_rate > 0
        ),
        CONSTRAINT quotes_client_rate_not_above_mid CHECK (client_rate <= mid_rate),
        CONSTRAINT quotes_spread_range CHECK (spread_basis_points >= 0 AND spread_basis_points < 10000),
        CONSTRAINT quotes_expires_after_issue CHECK (expires_at > issued_at),
        CONSTRAINT quotes_consumed_within_validity CHECK (
          consumed_at IS NULL OR (consumed_at >= issued_at AND consumed_at < expires_at)
        )
      )
    `);
    await queryRunner.query(`CREATE INDEX quotes_user_issued_index ON quotes (user_id, issued_at DESC)`);

    await queryRunner.query(`
      CREATE FUNCTION quotes_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP <> 'UPDATE' THEN
          RAISE EXCEPTION 'quotes are never deleted (attempted %)', TG_OP
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.consumed_at IS NOT NULL THEN
          RAISE EXCEPTION 'quote % was already consumed', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (to_jsonb(NEW) - 'consumed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'consumed_at') THEN
          RAISE EXCEPTION 'a quote is immutable except its single consumption'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER quotes_guard_mutation BEFORE UPDATE OR DELETE ON quotes
        FOR EACH ROW EXECUTE FUNCTION quotes_guard_mutation()
    `);
    await queryRunner.query(`
      CREATE TRIGGER quotes_refuse_truncate BEFORE TRUNCATE ON quotes
        FOR EACH STATEMENT EXECUTE FUNCTION quotes_guard_mutation()
    `);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON quotes FROM fx_app`);
    await queryRunner.query(`GRANT UPDATE (consumed_at) ON quotes TO fx_app`);

    await queryRunner.query(`
      ALTER TABLE transactions
        ADD CONSTRAINT transactions_quote_id_foreign_key FOREIGN KEY (quote_id) REFERENCES quotes (id)
    `);
    await queryRunner.query(`
      ALTER TABLE transactions
        ALTER COLUMN rate_display TYPE NUMERIC,
        ALTER COLUMN reference_rate TYPE NUMERIC
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE transactions
        ALTER COLUMN rate_display TYPE NUMERIC(24, 12),
        ALTER COLUMN reference_rate TYPE NUMERIC(24, 12)
    `);
    await queryRunner.query(`ALTER TABLE transactions DROP CONSTRAINT transactions_quote_id_foreign_key`);
    await queryRunner.query(`DROP TABLE quotes`);
    await queryRunner.query(`DROP FUNCTION quotes_guard_mutation()`);
    await queryRunner.query(`DROP TYPE quote_amount_mode`);
  }
}
