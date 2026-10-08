import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `transaction_type` gains `SETTLEMENT` (Phase 9 decision: a PSP settlement batch is posted
 * as its own transaction — DEBIT `BANK` net + `EXPENSE:PSP_FEES` fees / CREDIT
 * `PSP_RECEIVABLE` gross). On its own because a new enum value cannot be used in the
 * transaction that adds it (the Phase 7 `AddConversionFlowType` rule).
 */
export class AddSettlementTransactionType1791158400000 implements MigrationInterface {
  name = 'AddSettlementTransactionType1791158400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE transaction_type ADD VALUE 'SETTLEMENT'`);
  }

  async down(): Promise<void> {
    // Postgres cannot drop an enum value; the settlement tables' down removes every use of it.
  }
}
