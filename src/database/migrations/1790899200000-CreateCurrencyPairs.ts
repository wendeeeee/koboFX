import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `currency_pairs` (design §4.3–§4.5, §5.7; shape is a Phase 6 decision). Rows are
 * DIRECTIONAL: NGN→USD and USD→NGN are separate rows with their own spread and minimum,
 * because a rate is directional (handbook: FX rates) and the credited side of every
 * quote is `source × mid × (1 − spread)` (§5.6).
 *
 * Deltas vs the design: `spread_bps` → `spread_basis_points`, `min_amount_minor` →
 * `minimum_source_amount_minor` (naming rule; it bounds the amount the user sells); no
 * `bid_rate`/`ask_rate` — a static bid/ask here would be a manually set price, which is
 * the Phase 10 four-eyes RATE_OVERRIDE, and no provider we use supplies bid/ask.
 *
 * Spread changes are a four-eyes action (§9.2 SPREAD_CHANGE): until Phase 10 they are
 * made by migration, so `fx_app` may only read this table.
 */
export class CreateCurrencyPairs1790899200000 implements MigrationInterface {
  name = 'CreateCurrencyPairs1790899200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE currency_pairs (
        source_currency_code         CHAR(3)     NOT NULL REFERENCES currencies (code),
        target_currency_code         CHAR(3)     NOT NULL REFERENCES currencies (code),
        spread_basis_points          INTEGER     NOT NULL,
        minimum_source_amount_minor  BIGINT      NOT NULL,
        is_active                    BOOLEAN     NOT NULL DEFAULT TRUE,
        created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),

        PRIMARY KEY (source_currency_code, target_currency_code),
        CONSTRAINT currency_pairs_distinct_currencies CHECK (source_currency_code <> target_currency_code),
        -- Below 10,000 bps the client rate stays positive: mid × (1 − spread) > 0.
        CONSTRAINT currency_pairs_spread_range CHECK (spread_basis_points >= 0 AND spread_basis_points < 10000),
        CONSTRAINT currency_pairs_minimum_positive CHECK (minimum_source_amount_minor > 0)
      )
    `);
    await queryRunner.query(`
      CREATE TRIGGER currency_pairs_set_updated_at BEFORE UPDATE ON currency_pairs
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);

    // Every ordered pair of the seeded currencies (crosses are triangulated reference
    // mids, §4.3). NGN pairs: 150 bps (volatile, and priced off a rate up to one provider
    // cadence old); majors: 50 bps (§15 item 4). Minimums ≈ ₦1,000 / $1 / €1 / £1.
    await queryRunner.query(`
      INSERT INTO currency_pairs (source_currency_code, target_currency_code, spread_basis_points, minimum_source_amount_minor)
      SELECT source.code, target.code,
             CASE WHEN 'NGN' IN (source.code, target.code) THEN 150 ELSE 50 END,
             CASE WHEN source.code = 'NGN' THEN 100000 ELSE 100 END
        FROM currencies source
        CROSS JOIN currencies target
       WHERE source.code <> target.code
         AND source.code IN ('NGN', 'USD', 'EUR', 'GBP')
         AND target.code IN ('NGN', 'USD', 'EUR', 'GBP')
    `);

    await queryRunner.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON currency_pairs FROM fx_app`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE currency_pairs`);
  }
}
