import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { PeriodLockedError } from '../../ledger/ledger.errors';
import { ActionPreconditionFailedError } from '../admin.errors';

/**
 * A correction's or write-off's value time (Phase 10 plan §E.4): explicit, never in the future, and never inside
 * a locked reporting period (design §5.3 — refused, never re-dated; `post()` refuses it again under its own
 * read, so a period closed between this check and the posting is still refused).
 */
export async function assertValueTimeBookable(unitOfWork: UnitOfWork, valueTime: Date): Promise<void> {
  const [row] = (await unitOfWork.manager.query(
    `SELECT now() AS now,
            (SELECT id::text FROM period_locks WHERE period_start <= $1 AND $1 < period_end ORDER BY period_start LIMIT 1) AS lock_id`,
    [valueTime],
  )) as { now: Date; lock_id: string | null }[];
  if (valueTime.getTime() > row.now.getTime()) {
    throw new ActionPreconditionFailedError('VALUE_TIME_IN_FUTURE', 'The value time is in the future.', { valueTime: valueTime.toISOString() });
  }
  if (row.lock_id !== null) {
    throw new PeriodLockedError('valueTime falls inside a locked reporting period.', { valueTime: valueTime.toISOString(), periodLockId: row.lock_id });
  }
}
