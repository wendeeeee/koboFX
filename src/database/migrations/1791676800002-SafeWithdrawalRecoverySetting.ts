import { MigrationInterface, QueryRunner } from 'typeorm';

/** A cleared transaction-local setting survives as an empty string on pooled PostgreSQL connections. */
export class SafeWithdrawalRecoverySetting1791676800002 implements MigrationInterface {
  name = 'SafeWithdrawalRecoverySetting1791676800002';

  async up(queryRunner: QueryRunner): Promise<void> {
    // SQL may reorder WHERE predicates: put the UUID cast inside CASE, after validation.
    // CREATE OR REPLACE preserves the existing function's owner and execution grants.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION withdrawal_recovery_payload(p_flow_id UUID) RETURNS JSONB AS $$
        SELECT approvals.payload FROM approvals
         WHERE approvals.id = CASE
           WHEN current_setting('fx.withdrawal_recovery', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN current_setting('fx.withdrawal_recovery', true)::uuid
           ELSE NULL
         END
           AND approvals.action_type = 'PAYSTACK_WITHDRAWAL_RECOVERY'
           AND approvals.status = 'APPROVED'
           AND approvals.payload ->> 'withdrawalId' = p_flow_id::text
      $$ LANGUAGE sql STABLE
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION withdrawal_recovery_payload(p_flow_id UUID) RETURNS JSONB AS $$
        SELECT approvals.payload FROM approvals
         WHERE current_setting('fx.withdrawal_recovery', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           AND approvals.id = current_setting('fx.withdrawal_recovery', true)::uuid
           AND approvals.action_type = 'PAYSTACK_WITHDRAWAL_RECOVERY'
           AND approvals.status = 'APPROVED'
           AND approvals.payload ->> 'withdrawalId' = p_flow_id::text
      $$ LANGUAGE sql STABLE
    `);
  }
}
