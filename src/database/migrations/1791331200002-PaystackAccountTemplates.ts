import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-provider receivable and clearing accounts for Paystack (PAYSTACK_PLAN.md C6): data only, provisioned at boot
 * × currency × bucket like every template. Named so that their codes (`PAYSTACK_RECEIVABLE:NGN`) never match the
 * simulated PSP's `PSP_RECEIVABLE:%` / `CLEARING:%` — so no Phase 9 query changes and the simulated PSP's receivable
 * proof is untouched. Capture: DR `PAYSTACK_RECEIVABLE` / CR the user, gross.
 */
export class PaystackAccountTemplates1791331200002 implements MigrationInterface {
  name = 'PaystackAccountTemplates1791331200002';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO system_account_templates (name, account_type, normal_side, description) VALUES
        ('PAYSTACK_RECEIVABLE', 'ASSET', 'DEBIT', 'Paid through Paystack, not yet settled to us'),
        ('PAYSTACK_CLEARING',   'ASSET', 'DEBIT', 'Paystack suspense: in transit or not yet attributable')
    `);
  }

  async down(): Promise<void> {
    // Templates change by migration only, and accounts provisioned from them may hold entries: never removed.
  }
}
