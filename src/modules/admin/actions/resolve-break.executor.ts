import { Injectable } from '@nestjs/common';
import { ResolutionKind, BreakStatus } from '../../reconciliation/break-transitions';
import { BreakService } from '../../reconciliation/break.service';
import { ActionPreconditionFailedError } from '../admin.errors';
import { ApprovalActionType } from '../approvals/approval.types';
import { ResolveBreakPayload } from './action-payloads';
import { ActionExecutor, ExecutionContext } from './action-registry';

/**
 * RESOLVE_BREAK: close a break with an operator's documented decision — `OPERATOR_RESOLVED`, citing the approval
 * (e.g. a foreign payment never settled to us, a false positive investigated). No money moves, yet it is four-eyes:
 * hiding a break misstates the books as surely as a wrong posting. The why is the approval's reason.
 */
@Injectable()
export class ResolveBreakExecutor implements ActionExecutor<ApprovalActionType.RESOLVE_BREAK> {
  readonly actionType = ApprovalActionType.RESOLVE_BREAK;

  constructor(private readonly breaks: BreakService) {}

  async validateRequest(payload: ResolveBreakPayload): Promise<void> {
    const found = await this.breaks.findById(payload.breakId);
    if (!found) throw new ActionPreconditionFailedError('BREAK_NOT_FOUND', 'No such break.', { breakId: payload.breakId });
    if (found.status === BreakStatus.RESOLVED) throw new ActionPreconditionFailedError('BREAK_NOT_LIVE', 'The break is already resolved.', { breakId: payload.breakId });
  }

  async execute(payload: ResolveBreakPayload, context: ExecutionContext): Promise<string> {
    await this.validateRequest(payload);
    const resolved = await this.breaks.resolve(
      payload.breakId,
      `operator:${context.executedBy}`,
      ResolutionKind.OPERATOR_RESOLVED,
      `approval:${context.approvalId}`,
      context.reason,
    );
    if (!resolved) throw new ActionPreconditionFailedError('BREAK_NOT_LIVE', 'The break was resolved meanwhile.', { breakId: payload.breakId });
    return payload.breakId;
  }
}
