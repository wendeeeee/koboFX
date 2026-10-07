import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Withdrawal codes (2026-10-07 decision): a withdrawal must carry a one-time password emailed for it. The challenges
 * reuse the Phase 4 machinery — a row per issued challenge (`one_time_password_challenges`, at most one open per user
 * and purpose), the code's HMAC and attempt counter in Redis only — under a new purpose.
 */
export class AddWithdrawalOneTimePasswordPurpose1791763200000 implements MigrationInterface {
  name = 'AddWithdrawalOneTimePasswordPurpose1791763200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE one_time_password_purpose ADD VALUE 'AUTHORIZE_WITHDRAWAL'`);
  }

  async down(): Promise<void> {
    // Postgres cannot drop an enum value; rows using it are evidence and are never deleted.
  }
}
