import { Injectable } from '@nestjs/common';
import { sqlState } from '../../../database/database-errors';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { AuditAction, AuditLogService, AuditSubjectType } from '../../audit/audit-log.service';
import { UserRole, UserStatus } from '../../users/user.types';
import { ActionPreconditionFailedError } from '../admin.errors';
import { ApprovalActionType } from '../approvals/approval.types';
import { RoleChangeOperation, RoleChangePayload } from './action-payloads';
import { ActionExecutor, ExecutionContext } from './action-registry';

/**
 * ROLE_CHANGE (design §9.3 "authorization changes are audit events"; handbook: access control). Requested by an
 * ADMIN, approved by a SECURITY officer. `fx_app` cannot change `users.role` (Phase 4 decision 9): the change
 * reaches it only through `apply_role_change(approval_id)`, which re-reads the APPROVED approval, serialises
 * changes to one role, refuses self-grants and the revocation of the last active holder, and writes
 * `role_assignments` (the recertification record). Effective on the target's NEXT request: every request re-reads
 * the role (Phase 4 decision 8), so a revoked ADMIN loses access then, not at token expiry.
 */
@Injectable()
export class RoleChangeExecutor implements ActionExecutor<ApprovalActionType.ROLE_CHANGE> {
  readonly actionType = ApprovalActionType.ROLE_CHANGE;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditLogService,
  ) {}

  async validateRequest(payload: RoleChangePayload, requestedBy: string): Promise<void> {
    if (payload.userId === requestedBy) throw new ActionPreconditionFailedError('SELF_TARGETED', 'Nobody requests their own role change.');
    await this.assertApplicable(payload);
  }

  async execute(payload: RoleChangePayload, context: ExecutionContext): Promise<string> {
    if (payload.userId === context.requestedBy || payload.userId === context.executedBy) {
      throw new ActionPreconditionFailedError('SELF_TARGETED', 'Nobody requests or approves their own role change.');
    }
    await this.assertApplicable(payload);
    let assignmentId: string;
    try {
      const [row] = (await this.unitOfWork.requireTransaction().query(`SELECT apply_role_change($1)::text AS assignment_id`, [context.approvalId])) as {
        assignment_id: string;
      }[];
      assignmentId = row.assignment_id;
    } catch (error) {
      // The function decides "the last holder" under its own lock: a race the check above lost lands here.
      if (sqlState(error) === '23514') {
        throw new ActionPreconditionFailedError('ROLE_CHANGE_REFUSED', error instanceof Error ? error.message : 'The role change was refused.', {
          userId: payload.userId,
        });
      }
      throw error;
    }
    const granted = payload.operation === RoleChangeOperation.GRANT;
    await this.audit.record({
      actor: { type: 'OPERATOR', id: context.executedBy },
      action: granted ? AuditAction.ROLE_GRANTED : AuditAction.ROLE_REVOKED,
      subject: { type: AuditSubjectType.USER, id: payload.userId },
      before: { role: granted ? UserRole.USER : (payload.role as UserRole) },
      after: { role: granted ? (payload.role as UserRole) : UserRole.USER, approvalId: context.approvalId },
      reason: context.reason,
    });
    return assignmentId;
  }

  private async assertApplicable(payload: RoleChangePayload): Promise<void> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT users.status, users.role,
              (SELECT count(*) FROM users holders WHERE holders.role = $2::user_role AND holders.status = 'ACTIVE' AND holders.id <> users.id)::int
                AS other_holders
         FROM users WHERE users.id = $1`,
      [payload.userId, payload.role],
    )) as { status: UserStatus; role: UserRole; other_holders: number }[];
    if (!row) throw new ActionPreconditionFailedError('USER_NOT_FOUND', 'No such user.', { userId: payload.userId });
    if (payload.operation === RoleChangeOperation.GRANT) {
      if (row.status !== UserStatus.ACTIVE) throw new ActionPreconditionFailedError('USER_NOT_ACTIVE', 'Roles are granted to active users only.', { userId: payload.userId });
      if (row.role !== UserRole.USER) {
        throw new ActionPreconditionFailedError('USER_ALREADY_PRIVILEGED', `The user already holds ${row.role}: one role per person.`, { userId: payload.userId });
      }
    } else {
      if (row.role !== payload.role) throw new ActionPreconditionFailedError('ROLE_NOT_HELD', `The user does not hold ${payload.role}.`, { userId: payload.userId });
      if (row.other_holders < 1) {
        throw new ActionPreconditionFailedError('LAST_ROLE_HOLDER', `Refusing to revoke the last active ${payload.role}.`, { userId: payload.userId });
      }
    }
  }
}
