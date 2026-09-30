import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closing a reporting period is four-eyes (Phase 10 plan §E.8) — delta from Phase 2 decision 4 ("`fx_app`
 * may SELECT/INSERT"): `fx_app` loses INSERT on `period_locks`, so an approval is the only way in.
 *
 * `close_reporting_period(approval_id)` (SECURITY DEFINER — `LOCK TABLE … ACCESS EXCLUSIVE` needs a privilege
 * `fx_app` does not have):
 * 1. re-reads the approval: an APPROVED CLOSE_PERIOD;
 * 2. takes `ACCESS EXCLUSIVE` on `period_locks` (Phase 2 decision 4). A posting that has already read the
 *    locks holds ACCESS SHARE until it commits, so the close waits for it — it lands inside the period,
 *    before the lock exists. A posting that starts during the close queues behind it and then sees the lock;
 * 3. under the lock: the period has ended, overlaps no lock, and continues the locked history without a gap;
 * 4. inserts the lock, `locked_by = operator:{approver}`, linked to the approval.
 */
export class PeriodLocksApproval1791244800006 implements MigrationInterface {
  name = 'PeriodLocksApproval1791244800006';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE period_locks ADD COLUMN approval_id UUID UNIQUE REFERENCES approvals (id)`);
    await queryRunner.query(`REVOKE INSERT ON period_locks FROM fx_app`);
    await queryRunner.query(`
      CREATE FUNCTION close_reporting_period(p_approval_id UUID) RETURNS BIGINT
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
      DECLARE
        approval  approvals%ROWTYPE;
        starts    TIMESTAMPTZ;
        ends      TIMESTAMPTZ;
        lock_id   BIGINT;
      BEGIN
        SELECT * INTO approval FROM approvals WHERE id = p_approval_id FOR UPDATE;
        IF NOT FOUND OR approval.action_type <> 'CLOSE_PERIOD' OR approval.status <> 'APPROVED' OR approval.approved_by IS NULL
           OR approval.approved_by = approval.requested_by THEN
          RAISE EXCEPTION 'closing a period needs an APPROVED CLOSE_PERIOD approval (%)', p_approval_id
            USING ERRCODE = 'insufficient_privilege';
        END IF;
        starts := (approval.payload ->> 'periodStart')::timestamptz;
        ends := (approval.payload ->> 'periodEnd')::timestamptz;

        LOCK TABLE period_locks IN ACCESS EXCLUSIVE MODE;

        IF ends > now() THEN
          RAISE EXCEPTION 'PERIOD_NOT_ENDED' USING ERRCODE = 'check_violation';
        END IF;
        IF EXISTS (SELECT 1 FROM period_locks WHERE period_start < ends AND starts < period_end) THEN
          RAISE EXCEPTION 'PERIOD_ALREADY_LOCKED' USING ERRCODE = 'check_violation';
        END IF;
        IF EXISTS (SELECT 1 FROM period_locks WHERE period_end <= starts)
           AND NOT EXISTS (SELECT 1 FROM period_locks WHERE period_end = starts) THEN
          RAISE EXCEPTION 'PERIOD_NOT_CONTIGUOUS' USING ERRCODE = 'check_violation';
        END IF;

        INSERT INTO period_locks (period_start, period_end, locked_by, reason, approval_id)
          VALUES (starts, ends, 'operator:' || approval.approved_by::text, approval.reason, approval.id)
          RETURNING id INTO lock_id;
        RETURN lock_id;
      END $$
    `);
    await queryRunner.query(`REVOKE EXECUTE ON FUNCTION close_reporting_period(UUID) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION close_reporting_period(UUID) TO fx_app`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION close_reporting_period(UUID)`);
    await queryRunner.query(`GRANT INSERT ON period_locks TO fx_app`);
    await queryRunner.query(`ALTER TABLE period_locks DROP COLUMN approval_id`);
  }
}
