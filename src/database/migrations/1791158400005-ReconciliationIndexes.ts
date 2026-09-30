import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes the reconciliation jobs read through (Phase 9). Indexes only.
 *
 * - `funding_payments_unsettled_index`: posted deposits not yet settled, by currency and
 *   capture time — the T+X window check reads the oldest first.
 * - `webhook_events_unmatched_index`: the `UNMATCHED` webhooks kept for reconciliation.
 *
 * (`transactions_external_reference_index` already exists since Phase 2.) Small tables at this
 * stage, so plain `CREATE INDEX` inside the migration transaction; production rollout would
 * use `CONCURRENTLY`.
 */
export class ReconciliationIndexes1791158400005 implements MigrationInterface {
  name = 'ReconciliationIndexes1791158400005';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX funding_payments_unsettled_index ON funding_payments (currency_code, captured_at)
        WHERE funding_transaction_id IS NOT NULL AND settlement_batch_line_id IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX webhook_events_unmatched_index ON webhook_events (received_at) WHERE outcome = 'UNMATCHED'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX webhook_events_unmatched_index`);
    await queryRunner.query(`DROP INDEX funding_payments_unsettled_index`);
  }
}
