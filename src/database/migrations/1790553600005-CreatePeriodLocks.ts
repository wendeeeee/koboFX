import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `period_locks` (design §5.3): once a period has been reported to the outside
 * world it is stone — no posting may carry a `value_time` inside it.
 *
 * Shape decided 2026-09-28: global (not per currency), half-open
 * `[period_start, period_end)`. The application may read and add locks, never edit or
 * remove them. Closing a period (Phase 10) must take `ACCESS EXCLUSIVE` on this
 * table so no in-flight posting can straddle the close.
 */
export class CreatePeriodLocks1790553600005 implements MigrationInterface {
  name = 'CreatePeriodLocks1790553600005';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE period_locks (
        id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        period_start  TIMESTAMPTZ NOT NULL,
        period_end    TIMESTAMPTZ NOT NULL,
        locked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        locked_by     TEXT        NOT NULL CHECK (locked_by ~ '^(operator|job):.+$'),
        reason        TEXT        NOT NULL,
        CONSTRAINT period_locks_period_ordered CHECK (period_start < period_end)
      )
    `);
    await queryRunner.query(`CREATE INDEX period_locks_period_index ON period_locks (period_start, period_end)`);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON period_locks FROM fx_app`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE period_locks`);
  }
}
