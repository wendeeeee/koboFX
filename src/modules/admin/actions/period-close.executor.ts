import { Injectable } from '@nestjs/common';
import { sqlState } from '../../../database/database-errors';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { AuditAction, AuditLogService, AuditSubjectType } from '../../audit/audit-log.service';
import { BREAK_POLICIES, BreakType } from '../../reconciliation/break-types';
import { ActionPreconditionFailedError } from '../admin.errors';
import { ApprovalActionType } from '../approvals/approval.types';
import { ClosePeriodPayload } from './action-payloads';
import { ActionExecutor, ExecutionContext } from './action-registry';

/** Breaks that block a close: money is wrong (MONEY) or someone edited the database (SECURITY). */
export const PERIOD_BLOCKING_BREAK_TYPES: readonly BreakType[] = (Object.keys(BREAK_POLICIES) as BreakType[]).filter(
  (type) => BREAK_POLICIES[type].severity !== 'INVESTIGATE',
);

/** The stable codes `close_reporting_period` raises (its messages ARE the codes). */
const DATABASE_REFUSALS = ['PERIOD_NOT_ENDED', 'PERIOD_ALREADY_LOCKED', 'PERIOD_NOT_CONTIGUOUS'] as const;

/**
 * CLOSE_PERIOD (design §5.3 "once reported, it is stone"; Phase 2 decision 4; Phase 10 plan §E.8). Monthly, UTC.
 * Preconditions, checked at request and again at execution: the month has ended; no live MONEY or SECURITY break
 * (you do not report books you know are wrong); a CLEAN internal reconciliation finished after the month's end
 * (the books were proven after the last posting that could land in it). Then `close_reporting_period` takes
 * `ACCESS EXCLUSIVE` on `period_locks` and, under it, refuses an overlap or a gap and inserts the lock.
 * In flight: a posting that already read the locks finishes inside the period first; one that starts during the
 * close waits, then sees the lock and is refused `PERIOD_LOCKED`. Under load the close may meet `lock_timeout`:
 * `503 RESOURCE_BUSY`, transient — the approver retries.
 */
@Injectable()
export class PeriodCloseExecutor implements ActionExecutor<ApprovalActionType.CLOSE_PERIOD> {
  readonly actionType = ApprovalActionType.CLOSE_PERIOD;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditLogService,
  ) {}

  async validateRequest(payload: ClosePeriodPayload): Promise<void> {
    await this.assertClosable(payload);
  }

  async execute(payload: ClosePeriodPayload, context: ExecutionContext): Promise<string> {
    await this.assertClosable(payload);
    const manager = this.unitOfWork.requireTransaction();
    let lockId: string;
    try {
      const [row] = (await manager.query(`SELECT close_reporting_period($1)::text AS lock_id`, [context.approvalId])) as { lock_id: string }[];
      lockId = row.lock_id;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const code = DATABASE_REFUSALS.find((candidate) => message.includes(candidate));
      if (sqlState(error) === '23514' && code) throw new ActionPreconditionFailedError(code, `The period cannot be closed: ${code}.`, { month: payload.month });
      throw error;
    }
    await this.audit.record({
      actor: { type: 'OPERATOR', id: context.executedBy },
      action: AuditAction.PERIOD_CLOSED,
      subject: { type: AuditSubjectType.APPROVAL, id: context.approvalId },
      after: { approvalId: context.approvalId, periodStart: payload.periodStart, periodEnd: payload.periodEnd, periodLockId: lockId },
      reason: context.reason,
    });
    return lockId;
  }

  private async assertClosable(payload: ClosePeriodPayload): Promise<void> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT now() >= $1::timestamptz AS ended,
              EXISTS (SELECT 1 FROM period_locks WHERE period_start < $1::timestamptz AND $2::timestamptz < period_end) AS locked,
              (SELECT count(*) FROM reconciliation_breaks
                WHERE status <> 'RESOLVED' AND type = ANY($3::reconciliation_break_type[]))::int AS blocking_breaks,
              EXISTS (SELECT 1 FROM reconciliation_runs
                       WHERE kind = 'INTERNAL' AND status = 'CLEAN' AND finished_at >= $1::timestamptz) AS proven`,
      [payload.periodEnd, payload.periodStart, [...PERIOD_BLOCKING_BREAK_TYPES]],
    )) as { ended: boolean; locked: boolean; blocking_breaks: number; proven: boolean }[];
    if (!row.ended) throw new ActionPreconditionFailedError('PERIOD_NOT_ENDED', 'The month has not ended.', { month: payload.month });
    if (row.locked) throw new ActionPreconditionFailedError('PERIOD_ALREADY_LOCKED', 'The month is already locked.', { month: payload.month });
    if (row.blocking_breaks > 0) {
      throw new ActionPreconditionFailedError('MONEY_BREAKS_OPEN', 'Live money or security breaks must be resolved before a close.', {
        month: payload.month,
        liveBreaks: row.blocking_breaks,
      });
    }
    if (!row.proven) {
      throw new ActionPreconditionFailedError('NO_CLEAN_INTERNAL_RUN', 'No clean internal reconciliation has finished since the month ended.', {
        month: payload.month,
      });
    }
  }
}
