import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Paystack (PAYSTACK_PLAN.md): `flow_type` gains `PAYSTACK_FUNDING` (its own state machine — Paystack has no
 * authorize/capture split), and `webhook_event_outcome` gains `SOURCE_NOT_ALLOWED` (a webhook from an address outside
 * `PAYSTACK_WEBHOOK_IP_ALLOWLIST`: stored as evidence, never processed). On their own because a new enum value cannot be
 * used in the transaction that adds it; the next migration uses them.
 */
export class AddPaystackEnumValues1791331200000 implements MigrationInterface {
  name = 'AddPaystackEnumValues1791331200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE flow_type ADD VALUE 'PAYSTACK_FUNDING'`);
    await queryRunner.query(`ALTER TYPE webhook_event_outcome ADD VALUE 'SOURCE_NOT_ALLOWED'`);
  }

  async down(): Promise<void> {
    // Postgres cannot drop an enum value; the next migration's down removes every use of it.
  }
}
