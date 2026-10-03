import { EntityManager } from 'typeorm';
import { WithdrawalUsage } from './withdrawal-limits';

/**
 * What counts against a wallet account's 24-hour withdrawal limit (WITHDRAWAL_PLAN.md §K). Call it AFTER locking the
 * account (`LedgerService.lockUserAccounts`) in the admitting transaction: the lock serialises racing admissions, and
 * the window is evaluated at `clock_timestamp()` — the wall time after the lock was granted, not the transaction's
 * start (`now()`), which may predate a long wait.
 *
 * - outstanding: every unposted, unfailed withdrawal of any age (a hold under review keeps counting);
 * - completed: posted in the last 24 hours, reversed or not (a reversal does not free the limit, so it cannot be
 *   cycled); a conclusive failure stops counting.
 */
export async function measureWithdrawalUsage(manager: EntityManager, accountId: string): Promise<WithdrawalUsage> {
  const [row] = (await manager.query(
    `SELECT
       (SELECT coalesce(sum(principal_minor), 0)::text FROM paystack_withdrawals
         WHERE account_id = $1 AND posted_at IS NULL AND failed_at IS NULL) AS outstanding_minor,
       (SELECT coalesce(sum(principal_minor), 0)::text FROM paystack_withdrawals
         WHERE account_id = $1 AND posted_at IS NOT NULL
           AND posted_at > clock_timestamp() - interval '24 hours') AS completed_in_window_minor`,
    [accountId],
  )) as { outstanding_minor: string; completed_in_window_minor: string }[];
  return {
    outstandingMinor: BigInt(row.outstanding_minor),
    completedInWindowMinor: BigInt(row.completed_in_window_minor),
  };
}
