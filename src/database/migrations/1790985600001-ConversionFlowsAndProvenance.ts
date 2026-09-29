import { MigrationInterface, QueryRunner } from 'typeorm';

const FUNDING_TRANSITIONS = `
          WHEN 'FUNDING' THEN (from_state, to_state) IN (
            ('INITIATED', 'AUTHORIZED'), ('INITIATED', 'FAILED'),
            ('AUTHORIZED', 'CAPTURED'), ('AUTHORIZED', 'FAILED'),
            ('CAPTURED', 'POSTED'),
            ('POSTED', 'SETTLED'), ('POSTED', 'REVERSED'),
            ('SETTLED', 'REVERSED'))`;

/**
 * Phase 7 (trading; CLAUDE.md 2026-09-29 decisions):
 *
 * - `CONVERSION` flows: `INITIATED → POSTED` only. A conversion creates its flow, reserves,
 *   settles and completes it in one transaction, so no other state is ever committed and the
 *   resumer never sees one. `conversion-transitions.ts` is the TypeScript mirror (tested equal).
 * - `transactions` + `rate_snapshot_id` (the ACCEPTED snapshot priced off — both USD mids are
 *   recoverable from it, the snapshot being immutable evidence) and `rate_provider_updated_at`
 *   (the provider's publication time: freshness is measured from it, Phase 6 decision 3).
 *   Deltas from design §5.4.
 * - By construction: a CONVERSION carries its full provenance (CHECK); it may only cite an
 *   ACCEPTED snapshot (insert trigger); a quote backs at most one conversion (unique index).
 * - `transactions_conversion_window_index`: the rolling 24-hour per-user, per-source-currency
 *   conversion limit sums over it, under the source account's row lock.
 */
export class ConversionFlowsAndProvenance1790985600001 implements MigrationInterface {
  name = 'ConversionFlowsAndProvenance1790985600001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION flow_transition_allowed(type flow_type, from_state TEXT, to_state TEXT) RETURNS BOOLEAN AS $$
        SELECT CASE type${FUNDING_TRANSITIONS}
          WHEN 'CONVERSION' THEN (from_state, to_state) IN (('INITIATED', 'POSTED'))
          ELSE FALSE
        END
      $$ LANGUAGE sql IMMUTABLE
    `);
    await queryRunner.query(`ALTER TABLE flow_instances DROP CONSTRAINT flow_instances_state_valid`);
    await queryRunner.query(`
      ALTER TABLE flow_instances ADD CONSTRAINT flow_instances_state_valid CHECK (
        (flow_type <> 'FUNDING'
          OR state IN ('INITIATED', 'AUTHORIZED', 'CAPTURED', 'POSTED', 'SETTLED', 'FAILED', 'REVERSED'))
        AND (flow_type <> 'CONVERSION' OR state IN ('INITIATED', 'POSTED'))
      )
    `);

    await queryRunner.query(`
      ALTER TABLE transactions
        ADD COLUMN rate_snapshot_id UUID REFERENCES exchange_rate_snapshots (id),
        ADD COLUMN rate_provider_updated_at TIMESTAMPTZ
    `);
    await queryRunner.query(`
      ALTER TABLE transactions ADD CONSTRAINT transactions_conversion_provenance CHECK (
        type <> 'CONVERSION' OR (
          source_currency IS NOT NULL AND target_currency IS NOT NULL AND source_currency <> target_currency
          AND source_amount_minor > 0 AND target_amount_minor > 0
          AND rate_display > 0 AND reference_rate > 0
          AND rate_provider IS NOT NULL AND rate_fetched_at IS NOT NULL
          AND rate_provider_updated_at IS NOT NULL AND rate_snapshot_id IS NOT NULL
          AND spread_basis_points >= 0 AND spread_basis_points < 10000
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX transactions_quote_id_unique
        ON transactions (quote_id) WHERE quote_id IS NOT NULL AND type = 'CONVERSION'
    `);
    await queryRunner.query(`
      CREATE INDEX transactions_conversion_window_index
        ON transactions (user_id, source_currency, booking_time) WHERE type = 'CONVERSION' AND status = 'POSTED'
    `);
    await queryRunner.query(`
      CREATE FUNCTION transactions_conversion_snapshot_accepted() RETURNS trigger AS $$
      BEGIN
        IF NEW.rate_snapshot_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM exchange_rate_snapshots WHERE id = NEW.rate_snapshot_id AND status = 'ACCEPTED') THEN
          RAISE EXCEPTION 'transaction % cites exchange rate snapshot %, which is not ACCEPTED', NEW.id, NEW.rate_snapshot_id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER transactions_conversion_snapshot_accepted BEFORE INSERT ON transactions
        FOR EACH ROW EXECUTE FUNCTION transactions_conversion_snapshot_accepted()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER transactions_conversion_snapshot_accepted ON transactions`);
    await queryRunner.query(`DROP FUNCTION transactions_conversion_snapshot_accepted()`);
    await queryRunner.query(`DROP INDEX transactions_conversion_window_index`);
    await queryRunner.query(`DROP INDEX transactions_quote_id_unique`);
    await queryRunner.query(`ALTER TABLE transactions DROP CONSTRAINT transactions_conversion_provenance`);
    await queryRunner.query(`ALTER TABLE transactions DROP COLUMN rate_provider_updated_at, DROP COLUMN rate_snapshot_id`);
    await queryRunner.query(`ALTER TABLE flow_instances DROP CONSTRAINT flow_instances_state_valid`);
    await queryRunner.query(`
      ALTER TABLE flow_instances ADD CONSTRAINT flow_instances_state_valid CHECK (
        flow_type <> 'FUNDING'
        OR state IN ('INITIATED', 'AUTHORIZED', 'CAPTURED', 'POSTED', 'SETTLED', 'FAILED', 'REVERSED')
      )
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION flow_transition_allowed(type flow_type, from_state TEXT, to_state TEXT) RETURNS BOOLEAN AS $$
        SELECT CASE type${FUNDING_TRANSITIONS}
          ELSE FALSE
        END
      $$ LANGUAGE sql IMMUTABLE
    `);
  }
}
