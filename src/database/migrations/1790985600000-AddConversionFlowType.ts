import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `flow_type` gains `CONVERSION` (Phase 7 decision: a synchronous conversion owns its
 * reservation through a flow row, handbook Flow 3 steps 1 and 5). On its own because a new
 * enum value cannot be used in the transaction that adds it; the next migration uses it.
 */
export class AddConversionFlowType1790985600000 implements MigrationInterface {
  name = 'AddConversionFlowType1790985600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE flow_type ADD VALUE 'CONVERSION'`);
  }

  async down(): Promise<void> {
    // Postgres cannot drop an enum value; the next migration's down removes every use of it.
  }
}
