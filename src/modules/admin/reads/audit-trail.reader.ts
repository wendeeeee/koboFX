import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { Approval } from '../approvals/approval.types';

/** One audit row, as the admin views show it: ids, codes and typed state — never personal data (design §9.5). */
export interface AuditTrailEntry {
  readonly occurredAt: string;
  readonly action: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly reason: string;
}

interface AuditRow {
  occurred_at: Date;
  action: string;
  actor_type: string;
  actor_id: string | null;
  subject_type: string;
  subject_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string;
}

const toEntry = (row: AuditRow): AuditTrailEntry => ({
  occurredAt: row.occurred_at.toISOString(),
  action: row.action,
  actorType: row.actor_type,
  actorId: row.actor_id,
  subjectType: row.subject_type,
  subjectId: row.subject_id,
  before: row.before,
  after: row.after,
  reason: row.reason,
});

/**
 * The trail, navigable both ways (Phase 10 plan §E.12): an approval's rows (subject = the approval) plus every row
 * that names it (`after.approvalId`: the posting, the role or status change, the snapshot) plus — through its
 * `result_reference` and `break_id` — the break's own rows. A break's rows lead back through the resolution's
 * reference `approval:{id}`.
 */
@Injectable()
export class AuditTrailReader {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async forApproval(approval: Approval): Promise<AuditTrailEntry[]> {
    const subjects = [approval.id, ...(approval.breakId ? [approval.breakId] : [])];
    const rows = (await this.unitOfWork.manager.query(
      `SELECT occurred_at, action, actor_type, actor_id, subject_type, subject_id, before, after, reason
         FROM audit_logs
        WHERE subject_id = ANY($1::uuid[]) OR after ->> 'approvalId' = $2
        ORDER BY occurred_at, id`,
      [subjects, approval.id],
    )) as AuditRow[];
    return rows.map(toEntry);
  }

  async forSubject(subjectId: string): Promise<AuditTrailEntry[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT occurred_at, action, actor_type, actor_id, subject_type, subject_id, before, after, reason
         FROM audit_logs WHERE subject_id = $1 ORDER BY occurred_at, id`,
      [subjectId],
    )) as AuditRow[];
    return rows.map(toEntry);
  }
}
