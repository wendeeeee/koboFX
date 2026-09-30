import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `reconciliation_runs` (Phase 9; design §8): one row per kind and period, so a run that
 * happened is provable and a run that did not is visible — an absent run is never "clean".
 *
 * - `UNIQUE (kind, period_key)`: two workers claiming the same period get ONE run
 *   (`INSERT … ON CONFLICT DO NOTHING`). A lease (`leased_until` + `lease_token`, as flows)
 *   says who is working on it; a dead worker's lease lapses and the run is resumed.
 * - `RUNNING` → `CLEAN` | `BREAKS_FOUND` (finished, then immutable). `MISSED` is inserted
 *   finished: a period nobody ran (the worker was down), recorded so the gap is explicit.
 * - `fx_app`: SELECT, INSERT, and UPDATE of the progress columns only; no DELETE/TRUNCATE.
 */
export class CreateReconciliationRuns1791158400003 implements MigrationInterface {
  name = 'CreateReconciliationRuns1791158400003';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE reconciliation_run_kind AS ENUM ('INTERNAL', 'EXTERNAL_DAILY', 'EXTERNAL_HOURLY')`);
    await queryRunner.query(`CREATE TYPE reconciliation_run_status AS ENUM ('RUNNING', 'CLEAN', 'BREAKS_FOUND', 'MISSED')`);
    await queryRunner.query(`
      CREATE TABLE reconciliation_runs (
        id             UUID                      PRIMARY KEY DEFAULT gen_random_uuid(),
        kind           reconciliation_run_kind   NOT NULL,
        period_key     TEXT                      NOT NULL,
        status         reconciliation_run_status NOT NULL,
        attempts       INTEGER                   NOT NULL DEFAULT 0,
        leased_until   TIMESTAMPTZ,
        lease_token    UUID,
        started_at     TIMESTAMPTZ               NOT NULL DEFAULT now(),
        finished_at    TIMESTAMPTZ,
        snapshot_at    TIMESTAMPTZ,
        summary        JSONB                     NOT NULL DEFAULT '{}',
        last_error     TEXT,

        CONSTRAINT reconciliation_runs_period_unique UNIQUE (kind, period_key),
        CONSTRAINT reconciliation_runs_period_key_format
          CHECK (period_key ~ '^\\d{4}-\\d{2}-\\d{2}(T\\d{2})?$'),
        CONSTRAINT reconciliation_runs_finished_when_final
          CHECK ((status = 'RUNNING') = (finished_at IS NULL)),
        CONSTRAINT reconciliation_runs_no_lease_when_final
          CHECK (status = 'RUNNING' OR (leased_until IS NULL AND lease_token IS NULL)),
        CONSTRAINT reconciliation_runs_attempts_non_negative CHECK (attempts >= 0)
      )
    `);
    await queryRunner.query(`CREATE INDEX reconciliation_runs_running_index ON reconciliation_runs (kind, period_key) WHERE status = 'RUNNING'`);

    await queryRunner.query(`
      CREATE FUNCTION reconciliation_runs_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'reconciliation runs are never deleted (attempted DELETE on %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind
           OR NEW.period_key IS DISTINCT FROM OLD.period_key OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
          RAISE EXCEPTION 'reconciliation run % identity is immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.status <> 'RUNNING' THEN
          RAISE EXCEPTION 'reconciliation run % is finished (%) and immutable', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.status NOT IN ('RUNNING', 'CLEAN', 'BREAKS_FOUND') THEN
          RAISE EXCEPTION 'reconciliation run % cannot move from RUNNING to %', OLD.id, NEW.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER reconciliation_runs_guard_mutation BEFORE UPDATE OR DELETE ON reconciliation_runs
        FOR EACH ROW EXECUTE FUNCTION reconciliation_runs_guard_mutation()
    `);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON reconciliation_runs FROM fx_app`);
    await queryRunner.query(`
      GRANT UPDATE (status, attempts, leased_until, lease_token, finished_at, snapshot_at, summary, last_error)
        ON reconciliation_runs TO fx_app
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE reconciliation_runs`);
    await queryRunner.query(`DROP FUNCTION reconciliation_runs_guard_mutation()`);
    await queryRunner.query(`DROP TYPE reconciliation_run_status`);
    await queryRunner.query(`DROP TYPE reconciliation_run_kind`);
  }
}
