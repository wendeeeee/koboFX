import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { AuditAction, AuditLogService, AuditSubjectType } from '../../audit/audit-log.service';
import { RefreshTokenRevocationReason } from '../../auth/tokens/refresh-token-rotation';
import { RefreshTokenService } from '../../auth/tokens/refresh-token.service';
import { UserStatus } from '../../users/user.types';
import { ActionPreconditionFailedError } from '../admin.errors';
import { ApprovalActionType } from '../approvals/approval.types';
import { UserTargetPayload } from './action-payloads';
import { ActionExecutor, ExecutionContext } from './action-registry';

/**
 * SUSPEND_USER / REINSTATE_USER (design §9.2; Phase 10 plan §E.10). Symmetric, both four-eyes (suspension may also
 * be break-glass: a takeover in progress cannot wait for a second person).
 *
 * Suspension: ACTIVE → SUSPENDED under the user's row lock, and every live refresh session revoked. Access ends
 * on the next request (status is re-read on every request, Phase 4 decision 8); in-flight fundings follow Phase 5
 * decision 10; open quotes cannot be traded (the trade takes the user row `FOR SHARE` and refuses) and expire.
 * Reinstatement: SUSPENDED → ACTIVE; the revoked sessions stay revoked (the user logs in again).
 * Nobody suspends or reinstates themselves — neither as the requester nor as the approver.
 * (`@Injectable()` on the base so its constructor's parameter types are emitted for the subclasses.)
 */
@Injectable()
abstract class UserStatusExecutor {
  protected abstract readonly from: UserStatus;
  protected abstract readonly to: UserStatus;
  protected abstract readonly auditAction: AuditAction;

  constructor(
    protected readonly unitOfWork: UnitOfWork,
    protected readonly audit: AuditLogService,
    protected readonly refreshTokens: RefreshTokenService,
  ) {}

  async validateRequest(payload: UserTargetPayload, requestedBy: string): Promise<void> {
    if (payload.userId === requestedBy) throw new ActionPreconditionFailedError('SELF_TARGETED', 'Nobody changes their own status.');
    await this.current(payload.userId, false);
  }

  async execute(payload: UserTargetPayload, context: ExecutionContext): Promise<string> {
    if (payload.userId === context.requestedBy || payload.userId === context.executedBy) {
      throw new ActionPreconditionFailedError('SELF_TARGETED', 'Nobody changes their own status.');
    }
    await this.current(payload.userId, true);
    await this.unitOfWork.requireTransaction().query(`UPDATE users SET status = $2 WHERE id = $1`, [payload.userId, this.to]);
    await this.audit.record({
      actor: { type: 'OPERATOR', id: context.executedBy },
      action: this.auditAction,
      subject: { type: AuditSubjectType.USER, id: payload.userId },
      before: { status: this.from },
      after: { status: this.to, approvalId: context.approvalId, breakGlass: context.isBreakGlass },
      reason: context.reason,
    });
    if (this.to === UserStatus.SUSPENDED) {
      await this.refreshTokens.revokeAllForUser(payload.userId, RefreshTokenRevocationReason.USER_NOT_ACTIVE, {
        type: 'OPERATOR',
        id: context.executedBy,
      });
    }
    return payload.userId;
  }

  private async current(userId: string, lock: boolean): Promise<void> {
    const [row] = (await this.unitOfWork.manager.query(`SELECT status FROM users WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [userId])) as {
      status: UserStatus;
    }[];
    if (!row) throw new ActionPreconditionFailedError('USER_NOT_FOUND', 'No such user.', { userId });
    if (row.status !== this.from) {
      throw new ActionPreconditionFailedError('USER_STATUS_CHANGED', `The user is ${row.status}, not ${this.from}.`, { userId, status: row.status });
    }
  }
}

@Injectable()
export class SuspendUserExecutor extends UserStatusExecutor implements ActionExecutor<ApprovalActionType.SUSPEND_USER> {
  readonly actionType = ApprovalActionType.SUSPEND_USER;
  protected readonly from = UserStatus.ACTIVE;
  protected readonly to = UserStatus.SUSPENDED;
  protected readonly auditAction = AuditAction.USER_SUSPENDED;
}

@Injectable()
export class ReinstateUserExecutor extends UserStatusExecutor implements ActionExecutor<ApprovalActionType.REINSTATE_USER> {
  readonly actionType = ApprovalActionType.REINSTATE_USER;
  protected readonly from = UserStatus.SUSPENDED;
  protected readonly to = UserStatus.ACTIVE;
  protected readonly auditAction = AuditAction.USER_REINSTATED;
}
