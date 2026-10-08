import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * External reconciliation runs once PER PROVIDER (PAYSTACK_PLAN.md C7). `provider` NULL = the configured simulated
 * PSP (and the provider-independent INTERNAL run): every existing row, and every row the simulated PSP's runs keep
 * writing, is unchanged. Paystack's runs carry `'paystack'`. One run per (kind, provider, period); identity immutable.
 */
export class ReconciliationRunsProvider1791331200003 implements MigrationInterface {
  name = 'ReconciliationRunsProvider1791331200003';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE reconciliation_runs
        ADD COLUMN provider TEXT,
        ADD CONSTRAINT reconciliation_runs_provider_format CHECK (provider ~ '^[a-z0-9-]{1,32}$'),
        ADD CONSTRAINT reconciliation_runs_internal_has_no_provider CHECK (kind <> 'INTERNAL' OR provider IS NULL),
        DROP CONSTRAINT reconciliation_runs_period_unique
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX reconciliation_runs_period_unique ON reconciliation_runs (kind, COALESCE(provider, ''), period_key)
    `);
    await queryRunner.query(`
      CREATE FUNCTION reconciliation_runs_provider_immutable() RETURNS trigger AS $$
      BEGIN
        IF NEW.provider IS DISTINCT FROM OLD.provider THEN
          RAISE EXCEPTION 'reconciliation run % identity is immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER reconciliation_runs_provider_immutable BEFORE UPDATE ON reconciliation_runs
        FOR EACH ROW EXECUTE FUNCTION reconciliation_runs_provider_immutable()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER reconciliation_runs_provider_immutable ON reconciliation_runs`);
    await queryRunner.query(`DROP FUNCTION reconciliation_runs_provider_immutable()`);
    await queryRunner.query(`DROP INDEX reconciliation_runs_period_unique`);
    await queryRunner.query(`
      ALTER TABLE reconciliation_runs
        ADD CONSTRAINT reconciliation_runs_period_unique UNIQUE (kind, period_key),
        DROP CONSTRAINT reconciliation_runs_internal_has_no_provider,
        DROP CONSTRAINT reconciliation_runs_provider_format,
        DROP COLUMN provider
    `);
  }
}
