import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes only (Phase 10 admin reads): the breaks and runs lists are keyset-paginated newest first, and a break's
 * detail reads its findings. Without these, each page would sort the whole table.
 */
export class AdminReadIndexes1791244800007 implements MigrationInterface {
  name = 'AdminReadIndexes1791244800007';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX reconciliation_breaks_first_detected_index ON reconciliation_breaks (first_detected_at DESC, id DESC)`);
    await queryRunner.query(`CREATE INDEX reconciliation_runs_started_index ON reconciliation_runs (started_at DESC, id DESC)`);
    await queryRunner.query(`CREATE INDEX reconciliation_findings_break_index ON reconciliation_findings (break_id) WHERE break_id IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX role_assignments_user_index ON role_assignments (user_id, granted_at)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX role_assignments_user_index`);
    await queryRunner.query(`DROP INDEX reconciliation_findings_break_index`);
    await queryRunner.query(`DROP INDEX reconciliation_runs_started_index`);
    await queryRunner.query(`DROP INDEX reconciliation_breaks_first_detected_index`);
  }
}
