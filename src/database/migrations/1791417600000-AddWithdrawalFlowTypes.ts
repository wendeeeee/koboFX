import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Paystack withdrawals, W1 (WITHDRAWAL_PLAN.md §E): `flow_type` gains `PAYSTACK_BENEFICIARY` (destination preparation)
 * and `PAYSTACK_WITHDRAWAL` (the payout). On their own because a new enum value cannot be used in the transaction that
 * adds it; the migrations after this one use them.
 */
export class AddWithdrawalFlowTypes1791417600000 implements MigrationInterface {
  name = 'AddWithdrawalFlowTypes1791417600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE flow_type ADD VALUE 'PAYSTACK_BENEFICIARY'`);
    await queryRunner.query(`ALTER TYPE flow_type ADD VALUE 'PAYSTACK_WITHDRAWAL'`);
  }

  async down(): Promise<void> {
    // Postgres cannot drop an enum value; the later migrations' downs remove every use of them.
  }
}
