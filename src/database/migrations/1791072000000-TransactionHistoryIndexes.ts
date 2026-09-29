import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 8 (history: keyset read models; CLAUDE.md 2026-09-29 Phase 8 decisions). Indexes only —
 * no new column, no denormalised copy, no new write path. Every history page is an index scan
 * in keyset order (`(time, id) < (cursor)` … `ORDER BY time DESC, id DESC LIMIT n`), O(limit)
 * at row one and at row ten million; `transactions_indexes.int-spec` proves each plan by EXPLAIN.
 *
 * Deltas from design §5.4 / §7.8, which name only `txn_user_value_idx` (here
 * `transactions_user_value_time_index`, Phase 2):
 * - booking-time sort: `transactions_user_booking_time_index`;
 * - `type=` filter, either sort: `transactions_user_type_{value,booking}_time_index`;
 * - `currency=` filter ("any of the user's own legs is in this currency"), either sort: through
 *   the user's one account in that currency, `ledger_entries_account_{value,booking}_time_index`
 *   (entries copy the transaction's value time and share its `now()` booking time);
 * - fundings that never posted (PENDING / FAILED — history is the books plus those):
 *   `funding_payments_unposted_user_index`, and `funding_payments_unposted_user_currency_index` for
 *   `currency=` (a user with many failed NGN fundings asking for USD must not sort them all);
 *   both partial, so a funding leaves them when it posts.
 * - `type=` AND `currency=` together stream from one of the two and filter on the other: bounded
 *   by the user's rows of that type or in that currency, not strictly O(limit) (streaming both
 *   would need `type` on `ledger_entries`; accepted, PHASE8_PLAN §C.2).
 *
 * Built inside the migration transaction (small tables at this stage). On a large production
 * table, build each with `CREATE INDEX CONCURRENTLY` outside a transaction instead.
 */
export class TransactionHistoryIndexes1791072000000 implements MigrationInterface {
  name = 'TransactionHistoryIndexes1791072000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX transactions_user_booking_time_index ON transactions (user_id, booking_time DESC, id DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX transactions_user_type_value_time_index ON transactions (user_id, type, value_time DESC, id DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX transactions_user_type_booking_time_index ON transactions (user_id, type, booking_time DESC, id DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX ledger_entries_account_value_time_index ON ledger_entries (account_id, value_time DESC, transaction_id DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX ledger_entries_account_booking_time_index ON ledger_entries (account_id, booking_time DESC, transaction_id DESC)`,
    );
    await queryRunner.query(`
      CREATE INDEX funding_payments_unposted_user_index
        ON funding_payments (user_id, created_at DESC, flow_id DESC) WHERE funding_transaction_id IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX funding_payments_unposted_user_currency_index
        ON funding_payments (user_id, currency_code, created_at DESC, flow_id DESC) WHERE funding_transaction_id IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX funding_payments_unposted_user_currency_index`);
    await queryRunner.query(`DROP INDEX funding_payments_unposted_user_index`);
    await queryRunner.query(`DROP INDEX ledger_entries_account_booking_time_index`);
    await queryRunner.query(`DROP INDEX ledger_entries_account_value_time_index`);
    await queryRunner.query(`DROP INDEX transactions_user_type_booking_time_index`);
    await queryRunner.query(`DROP INDEX transactions_user_type_value_time_index`);
    await queryRunner.query(`DROP INDEX transactions_user_booking_time_index`);
  }
}
