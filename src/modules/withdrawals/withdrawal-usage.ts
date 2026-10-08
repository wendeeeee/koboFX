import { EntityManager } from 'typeorm';
import { WithdrawalUsage } from './withdrawal-limits';


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
