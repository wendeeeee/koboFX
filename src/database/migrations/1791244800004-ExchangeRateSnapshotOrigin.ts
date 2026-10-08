import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Where an ACCEPTED snapshot came from (Phase 10 plan §E.6):
 *
 * - `PROVIDER`: a fetch the sanity rules accepted (every row so far).
 * - `OVERRIDE`: an approved RATE_OVERRIDE accepting a REJECTED fetch as-is (a > 20% jump is never
 *   auto-accepted, Phase 6 decision 5): same provider, same provider times, same rates — so the normal
 *   freshness rules still decide whether it is executable — linked to the rejected fetch and the approval.
 * - `MANUAL`: an approved (or break-glass) manual rate for "all providers down, cache cold" (§16):
 *   `provider = 'manual'`, valid until its `provider_next_update_at`, with no publication grace.
 *
 * Nothing but an approval can mint OVERRIDE or MANUAL (CHECK); `provider = 'manual'` is reserved for them.
 * Evidence as before: rows are never updated or deleted.
 */
export class ExchangeRateSnapshotOrigin1791244800004 implements MigrationInterface {
  name = 'ExchangeRateSnapshotOrigin1791244800004';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE exchange_rate_snapshot_origin AS ENUM ('PROVIDER', 'OVERRIDE', 'MANUAL')`);
    await queryRunner.query(`
      ALTER TABLE exchange_rate_snapshots
        ADD COLUMN origin                 exchange_rate_snapshot_origin NOT NULL DEFAULT 'PROVIDER',
        ADD COLUMN overrides_snapshot_id  UUID UNIQUE REFERENCES exchange_rate_snapshots (id),
        ADD COLUMN approval_id            UUID UNIQUE REFERENCES approvals (id),
        ADD CONSTRAINT exchange_rate_snapshots_origin_shape CHECK (
          (origin = 'PROVIDER' AND approval_id IS NULL AND overrides_snapshot_id IS NULL AND provider <> 'manual')
          OR (origin = 'OVERRIDE' AND status = 'ACCEPTED' AND approval_id IS NOT NULL AND overrides_snapshot_id IS NOT NULL
              AND provider <> 'manual')
          OR (origin = 'MANUAL' AND status = 'ACCEPTED' AND approval_id IS NOT NULL AND overrides_snapshot_id IS NULL
              AND provider = 'manual')
        )
    `);
    await queryRunner.query(`
      CREATE FUNCTION exchange_rate_snapshots_check_override() RETURNS trigger AS $$
      BEGIN
        IF NEW.origin = 'OVERRIDE' AND NOT EXISTS (
             SELECT 1 FROM exchange_rate_snapshots overridden
              WHERE overridden.id = NEW.overrides_snapshot_id AND overridden.status = 'REJECTED'
                AND overridden.provider = NEW.provider
                AND overridden.provider_updated_at IS NOT DISTINCT FROM NEW.provider_updated_at
                AND overridden.provider_next_update_at IS NOT DISTINCT FROM NEW.provider_next_update_at) THEN
          RAISE EXCEPTION 'an override accepts a REJECTED fetch of the same provider as-is'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER exchange_rate_snapshots_check_override BEFORE INSERT ON exchange_rate_snapshots
        FOR EACH ROW EXECUTE FUNCTION exchange_rate_snapshots_check_override()
    `);
    // The read path: the latest ACCEPTED snapshot of the provider OR a manual one.
    await queryRunner.query(`
      CREATE INDEX exchange_rate_snapshots_latest_servable_index
        ON exchange_rate_snapshots (fetched_at DESC, provider_updated_at DESC, id DESC) WHERE status = 'ACCEPTED'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX exchange_rate_snapshots_latest_servable_index`);
    await queryRunner.query(`DROP TRIGGER exchange_rate_snapshots_check_override ON exchange_rate_snapshots`);
    await queryRunner.query(`DROP FUNCTION exchange_rate_snapshots_check_override()`);
    await queryRunner.query(`
      ALTER TABLE exchange_rate_snapshots
        DROP CONSTRAINT exchange_rate_snapshots_origin_shape,
        DROP COLUMN approval_id,
        DROP COLUMN overrides_snapshot_id,
        DROP COLUMN origin
    `);
    await queryRunner.query(`DROP TYPE exchange_rate_snapshot_origin`);
  }
}
