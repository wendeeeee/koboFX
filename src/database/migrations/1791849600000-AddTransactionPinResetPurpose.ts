import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Transaction PIN (2026-10-12 decision): a forgotten PIN is reset with the account password and an emailed code. The
 * code reuses the one-time-password machinery under its own purpose. A new enum value cannot be used in the transaction
 * that adds it, so the table that needs it comes in the next migration.
 */
export class AddTransactionPinResetPurpose1791849600000 implements MigrationInterface {
  name = 'AddTransactionPinResetPurpose1791849600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE one_time_password_purpose ADD VALUE 'RESET_TRANSACTION_PIN'`);
  }

  async down(): Promise<void> {
    // Postgres cannot drop an enum value; challenge rows using it are kept.
  }
}
