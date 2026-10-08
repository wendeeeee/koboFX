import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainError, ForbiddenError, InvariantViolationError } from '../../../common/errors';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { AuditAction, AuditLogService, AuditSubjectType } from '../../audit/audit-log.service';
import { OutboxService } from '../../outbox/outbox.service';
import { ApprovalChangedPayload, BreakGlassPayload, OutboxEventType } from '../../outbox/outbox.types';
import { UserRole, UserStatus } from '../../users/user.types';
import { AdminMetrics } from '../admin-metrics';
import {
  ActionPreconditionFailedError,
  ApprovalAlreadyDecidedError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  ApprovalRequesterIneligibleError,
  BreakGlassAlreadyReviewedError,
  BreakGlassNotAllowedError,
  SelfApprovalForbiddenError,
} from '../admin.errors';
import { breakIdOf, parseActionPayload, payloadHash } from '../actions/action-payloads';
import { ACTION_EXECUTORS, ACTION_POLICIES, ActionExecutor } from '../actions/action-registry';
import { assertApprovalTransition } from './approval-transitions';
import { ActorState, ApprovalRepository } from './approval.repository';
import { Approval, ApprovalActionType, ApprovalStatus } from './approval.types';

export interface ApprovalRequest {
  readonly actionType: ApprovalActionType;
  readonly payload: unknown;
  readonly reason: string;
  readonly breakGlass: boolean;
}

/** How many expired approvals / overdue break-glass uses one monitor tick handles. */
const MONITOR_BATCH_SIZE = 100;

function eligible(actor: ActorState | undefined, role: UserRole): boolean {
  return actor !== undefined && actor.status === UserStatus.ACTIVE && actor.role === role;
}

/** A refusal the approval records (EXECUTION_FAILED) rather than a fault that rolls everything back. */
function isRecordedRefusal(error: unknown): error is DomainError {
  return error instanceof DomainError && error.permanent && error.httpStatus < 500;
}

function failureCodeOf(error: DomainError): string {
  return error instanceof ActionPreconditionFailedError ? error.reason : error.code;
}

/**
 * Four-eyes (design §9.2; Phase 10 plan §E.2–§E.3, §E.7).
 *
 * - `request`: an eligible requester, a valid payload (canonicalised, hashed), the world checked once; PENDING.
 *   Break-glass (flagged, for the policy's subset only) executes at once, alone — and pages.
 * - `approve`: under the approval's row lock and `FOR SHARE` locks on both people — PENDING, not expired,
 *   not the requester, the decider holds the action's decider role and the requester still holds theirs —
 *   PENDING → APPROVED, then EXECUTION in the same transaction behind a savepoint: the executor re-validates
 *   against the world as it is now; a refusal rolls its work back to the savepoint and records EXECUTION_FAILED
 *   with a code, a transient fault rolls the whole decision back (the approver retries).
 * - `reject`, `cancel` (the requester, while PENDING), `review` (SECURITY, a break-glass use).
 * - Every transition: an audit row + `ApprovalChanged.v1`, in the same transaction. The database enforces the
 *   same rules (`four_eyes`, the transition trigger, `approvals_check_eligibility`): this layer refuses with a
 *   clean error first; that one makes bypassing it impossible.
 */
@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);
  private readonly executors: ReadonlyMap<ApprovalActionType, ActionExecutor>;
  private savepoints = 0;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly approvals: ApprovalRepository,
    private readonly audit: AuditLogService,
    private readonly outbox: OutboxService,
    private readonly metrics: AdminMetrics,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ACTION_EXECUTORS) executors: readonly ActionExecutor[],
  ) {
    this.executors = new Map(executors.map((executor) => [executor.actionType, executor]));
    for (const type of Object.values(ApprovalActionType)) {
      if (!this.executors.has(type)) throw new InvariantViolationError(`No executor is registered for ${type}.`);
    }
  }

  async request(requesterId: string, request: ApprovalRequest): Promise<Approval> {
    const policy = ACTION_POLICIES[request.actionType];
    const payload = parseActionPayload(request.actionType, request.payload);
    if (request.breakGlass && !policy.breakGlassAllowed(payload)) {
      throw new BreakGlassNotAllowedError({ actionType: request.actionType });
    }
    const executor = this.executorFor(request.actionType);
    return this.unitOfWork.run(async () => {
      const actors = await this.approvals.lockActors([requesterId]);
      if (!eligible(actors.get(requesterId), policy.requesterRole)) {
        throw new ForbiddenError('You do not have permission to request this action.', { actionType: request.actionType });
      }
      await executor.validateRequest(payload as never, requesterId);
      const approval = await this.approvals.insert({
        actionType: request.actionType,
        payload,
        payloadHash: payloadHash(payload),
        reason: request.reason,
        isBreakGlass: request.breakGlass,
        breakId: breakIdOf(payload),
        requestedBy: requesterId,
        timeToLiveHours: this.config.admin.approvalTimeToLiveHours,
      });
      await this.record(approval, AuditAction.APPROVAL_REQUESTED, requesterId, null, request.reason);
      this.logger.log(
        { approvalId: approval.id, actionType: approval.actionType, requestedBy: requesterId, breakGlass: approval.isBreakGlass },
        'Approval requested',
      );
      if (!request.breakGlass) return approval;
      return this.execute(approval, requesterId);
    });
  }

  async approve(approvalId: string, approverId: string): Promise<Approval> {
    return this.unitOfWork.run(async () => {
      const approval = await this.lockPending(approvalId);
      if (approval.requestedBy === approverId) throw new SelfApprovalForbiddenError(approvalId);
      await this.assertDecidable(approval, approverId);
      assertApprovalTransition(approval.status, ApprovalStatus.APPROVED, approval.isBreakGlass);
      const approved = await this.approvals.markApproved(approvalId, approverId);
      await this.record(approved, AuditAction.APPROVAL_APPROVED, approverId, approval.status, 'approved by a second person');
      return this.execute(approved, approverId);
    });
  }

  async reject(approvalId: string, rejecterId: string, reason: string): Promise<Approval> {
    return this.unitOfWork.run(async () => {
      const approval = await this.lockPending(approvalId);
      if (approval.requestedBy === rejecterId) throw new SelfApprovalForbiddenError(approvalId);
      await this.assertDecidable(approval, rejecterId);
      assertApprovalTransition(approval.status, ApprovalStatus.REJECTED, approval.isBreakGlass);
      const rejected = await this.approvals.markRejected(approvalId, rejecterId, reason);
      await this.record(rejected, AuditAction.APPROVAL_REJECTED, rejecterId, approval.status, reason);
      this.metrics.recordOutcome(rejected.actionType, rejected.status);
      return rejected;
    });
  }

  async cancel(approvalId: string, requesterId: string): Promise<Approval> {
    return this.unitOfWork.run(async () => {
      const approval = await this.lockPending(approvalId);
      if (approval.requestedBy !== requesterId) throw new ForbiddenError('Only the requester may cancel a request.', { approvalId });
      assertApprovalTransition(approval.status, ApprovalStatus.CANCELLED, approval.isBreakGlass);
      const cancelled = await this.approvals.markCancelled(approvalId, requesterId);
      await this.record(cancelled, AuditAction.APPROVAL_CANCELLED, requesterId, approval.status, 'cancelled by the requester');
      this.metrics.recordOutcome(cancelled.actionType, cancelled.status);
      return cancelled;
    });
  }

  /** SECURITY reviews a break-glass use (design §9.2: within 24 hours). Never the actor. */
  async review(approvalId: string, reviewerId: string, note: string): Promise<Approval> {
    return this.unitOfWork.run(async () => {
      const approval = await this.approvals.lock(approvalId);
      if (!approval) throw new ApprovalNotFoundError(approvalId);
      if (
        !approval.isBreakGlass ||
        approval.breakGlassReviewedAt !== null ||
        (approval.status !== ApprovalStatus.EXECUTED && approval.status !== ApprovalStatus.EXECUTION_FAILED)
      ) {
        throw new BreakGlassAlreadyReviewedError(approvalId);
      }
      if (approval.requestedBy === reviewerId) throw new SelfApprovalForbiddenError(approvalId);
      const actors = await this.approvals.lockActors([reviewerId]);
      if (!eligible(actors.get(reviewerId), UserRole.SECURITY)) {
        throw new ForbiddenError('Only a security officer reviews break-glass use.', { approvalId });
      }
      const reviewed = await this.approvals.markReviewed(approvalId, reviewerId, note);
      await this.audit.record({
        actor: { type: 'OPERATOR', id: reviewerId },
        action: AuditAction.BREAK_GLASS_REVIEWED,
        subject: { type: AuditSubjectType.APPROVAL, id: approvalId },
        after: { approvalId, actionType: approval.actionType, breakGlass: true, approvalStatus: approval.status },
        reason: note,
      });
      return reviewed;
    });
  }

  async find(approvalId: string): Promise<Approval> {
    const approval = await this.approvals.find(approvalId);
    if (!approval) throw new ApprovalNotFoundError(approvalId);
    return approval;
  }

  /** The worker's monitor: PENDING past expiry → EXPIRED (recorded), overdue break-glass reviews → paged once. */
  async sweep(): Promise<{ expired: number; overdueAlerted: number }> {
    const expired = await this.unitOfWork.run(async () => {
      const rows = await this.approvals.expireDue(MONITOR_BATCH_SIZE);
      for (const approval of rows) {
        await this.record(approval, AuditAction.APPROVAL_EXPIRED, null, ApprovalStatus.PENDING, 'nobody decided it before it expired');
        this.metrics.recordOutcome(approval.actionType, approval.status);
      }
      return rows.length;
    });
    const overdueAlerted = await this.unitOfWork.run(async () => {
      const rows = await this.approvals.claimOverdueBreakGlass(this.config.admin.breakGlassReviewHours, MONITOR_BATCH_SIZE);
      for (const approval of rows) {
        await this.audit.record({
          actor: { type: 'SYSTEM' },
          action: AuditAction.BREAK_GLASS_REVIEW_OVERDUE,
          subject: { type: AuditSubjectType.APPROVAL, id: approval.id },
          after: { approvalId: approval.id, actionType: approval.actionType, breakGlass: true },
          reason: `break-glass use not reviewed within ${this.config.admin.breakGlassReviewHours}h`,
        });
        const payload: BreakGlassPayload = { approvalId: approval.id, actionType: approval.actionType, actorId: approval.requestedBy };
        await this.outbox.enqueue(OutboxEventType.BREAK_GLASS_REVIEW_OVERDUE, approval.id, payload);
        this.logger.error({ approvalId: approval.id, actionType: approval.actionType }, 'Break-glass use not reviewed in time');
      }
      return rows.length;
    });
    this.metrics.recordUnreviewedBreakGlass(await this.approvals.countUnreviewedBreakGlass(this.config.admin.breakGlassReviewHours));
    return { expired, overdueAlerted };
  }

  private executorFor(actionType: ApprovalActionType): ActionExecutor {
    const executor = this.executors.get(actionType);
    if (!executor) throw new InvariantViolationError(`No executor is registered for ${actionType}.`);
    return executor;
  }

  private async lockPending(approvalId: string): Promise<Approval> {
    const approval = await this.approvals.lock(approvalId);
    if (!approval) throw new ApprovalNotFoundError(approvalId);
    if (approval.status !== ApprovalStatus.PENDING || approval.isBreakGlass) throw new ApprovalAlreadyDecidedError(approvalId, approval.status);
    return approval;
  }

  /** The decider holds the action's decider role; the requester still holds theirs; not expired. */
  private async assertDecidable(approval: Approval, deciderId: string): Promise<void> {
    const policy = ACTION_POLICIES[approval.actionType];
    const actors = await this.approvals.lockActors([approval.requestedBy, deciderId]);
    if (!eligible(actors.get(deciderId), policy.deciderRole)) {
      throw new ForbiddenError('You do not have permission to decide this action.', {
        approvalId: approval.id,
        actionType: approval.actionType,
        deciderRole: policy.deciderRole,
      });
    }
    if (!eligible(actors.get(approval.requestedBy), policy.requesterRole)) throw new ApprovalRequesterIneligibleError(approval.id);
    if (approval.expiresAt.getTime() <= (await this.approvals.now()).getTime()) throw new ApprovalExpiredError(approval.id, approval.expiresAt);
  }

  /**
   * Execute an APPROVED (or break-glass PENDING) approval, behind a savepoint. The payload is re-parsed with the
   * request-time schema, then the executor re-validates the world and acts.
   */
  private async execute(approval: Approval, executorId: string): Promise<Approval> {
    const manager = this.unitOfWork.requireTransaction();
    const executor = this.executorFor(approval.actionType);
    const savepoint = `approval_execution_${(this.savepoints += 1)}`;
    await manager.query(`SAVEPOINT ${savepoint}`);
    let result: Approval;
    try {
      const payload = parseActionPayload(approval.actionType, approval.payload);
      const reference = await executor.execute(payload as never, {
        approvalId: approval.id,
        requestedBy: approval.requestedBy,
        executedBy: executorId,
        isBreakGlass: approval.isBreakGlass,
        reason: approval.reason,
      });
      await manager.query(`RELEASE SAVEPOINT ${savepoint}`);
      result = await this.approvals.markExecuted(approval.id, executorId, reference, approval.status);
      await this.record(result, AuditAction.APPROVAL_EXECUTED, executorId, approval.status, `executed: ${reference}`);
      this.logger.log({ approvalId: approval.id, actionType: approval.actionType, executedBy: executorId, resultReference: reference }, 'Approval executed');
    } catch (error) {
      if (!isRecordedRefusal(error)) throw error;
      await manager.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      const code = failureCodeOf(error);
      result = await this.approvals.markExecutionFailed(approval.id, executorId, code, approval.status);
      await this.record(result, AuditAction.APPROVAL_EXECUTION_FAILED, executorId, approval.status, `refused at execution: ${code}`);
      this.logger.warn({ approvalId: approval.id, actionType: approval.actionType, failureCode: code }, 'Approval refused at execution');
    }
    this.metrics.recordOutcome(result.actionType, result.status);
    if (result.isBreakGlass) await this.page(result);
    return result;
  }

  /** Break-glass pages the security channel at once (design §9.2): an event, a metric, an audit row. */
  private async page(approval: Approval): Promise<void> {
    await this.audit.record({
      actor: { type: 'OPERATOR', id: approval.requestedBy },
      action: AuditAction.BREAK_GLASS_USED,
      subject: { type: AuditSubjectType.APPROVAL, id: approval.id },
      after: { approvalId: approval.id, actionType: approval.actionType, breakGlass: true, approvalStatus: approval.status },
      reason: approval.reason,
    });
    const payload: BreakGlassPayload = { approvalId: approval.id, actionType: approval.actionType, actorId: approval.requestedBy };
    await this.outbox.enqueue(OutboxEventType.BREAK_GLASS_USED, approval.id, payload);
    this.metrics.recordBreakGlassUse(approval.actionType);
    this.logger.error({ approvalId: approval.id, actionType: approval.actionType, actorId: approval.requestedBy }, 'BREAK-GLASS used: paging security');
  }

  private async record(approval: Approval, action: AuditAction, actorId: string | null, before: ApprovalStatus | null, reason: string): Promise<void> {
    await this.audit.record({
      actor: actorId ? { type: 'OPERATOR', id: actorId } : { type: 'SYSTEM' },
      action,
      subject: { type: AuditSubjectType.APPROVAL, id: approval.id },
      ...(before ? { before: { approvalStatus: before, actionType: approval.actionType } } : {}),
      after: {
        approvalStatus: approval.status,
        actionType: approval.actionType,
        breakGlass: approval.isBreakGlass,
        ...(approval.breakId ? { breakId: approval.breakId } : {}),
        ...(approval.executionFailureCode ? { failureCode: approval.executionFailureCode } : {}),
      },
      reason,
    });
    const payload: ApprovalChangedPayload = { approvalId: approval.id, actionType: approval.actionType, status: approval.status };
    await this.outbox.enqueue(OutboxEventType.APPROVAL_CHANGED, approval.id, payload);
  }
}
