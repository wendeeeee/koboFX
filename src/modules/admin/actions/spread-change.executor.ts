import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { AuditAction, AuditLogService, AuditSubjectType } from '../../audit/audit-log.service';
import { ActionPreconditionFailedError } from '../admin.errors';
import { ApprovalActionType } from '../approvals/approval.types';
import { SpreadChangePayload } from './action-payloads';
import { ActionExecutor, ExecutionContext } from './action-registry';

interface PairPricing {
  readonly spreadBasisPoints: number;
  readonly minimumSourceAmountMinor: string;
}

/**
 * SPREAD_CHANGE (design §9.2 "spread/limit changes"; Phase 6 decision 11). `currency_pairs` stays read-only to
 * `fx_app`: the change reaches the row only through `apply_currency_pair_change(approval_id)`, which re-reads the
 * APPROVED approval and applies exactly its payload. Quotes already issued keep the spread they locked. The
 * audit row holds the pricing before and after.
 */
@Injectable()
export class SpreadChangeExecutor implements ActionExecutor<ApprovalActionType.SPREAD_CHANGE> {
  readonly actionType = ApprovalActionType.SPREAD_CHANGE;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditLogService,
  ) {}

  async validateRequest(payload: SpreadChangePayload): Promise<void> {
    await this.pricing(payload);
  }

  async execute(payload: SpreadChangePayload, context: ExecutionContext): Promise<string> {
    await this.pricing(payload);
    const [changed] = (await this.unitOfWork.requireTransaction().query(
      `SELECT spread_before, minimum_before::text AS minimum_before, spread_after, minimum_after::text AS minimum_after
         FROM apply_currency_pair_change($1)`,
      [context.approvalId],
    )) as { spread_before: number; minimum_before: string; spread_after: number; minimum_after: string }[];
    const before: PairPricing = { spreadBasisPoints: changed!.spread_before, minimumSourceAmountMinor: changed!.minimum_before };
    const after: PairPricing = { spreadBasisPoints: changed!.spread_after, minimumSourceAmountMinor: changed!.minimum_after };
    const currencyPair = `${payload.sourceCurrency}/${payload.targetCurrency}`;
    await this.audit.record({
      actor: { type: 'OPERATOR', id: context.executedBy },
      action: AuditAction.CURRENCY_PAIR_CHANGED,
      subject: { type: AuditSubjectType.APPROVAL, id: context.approvalId },
      before: { currencyPair, spreadBasisPoints: before.spreadBasisPoints, minimumSourceAmountMinor: before.minimumSourceAmountMinor },
      after: { currencyPair, spreadBasisPoints: after.spreadBasisPoints, minimumSourceAmountMinor: after.minimumSourceAmountMinor },
      reason: context.reason,
    });
    return currencyPair;
  }

  /** The pair exists (the function reads it again, under its own lock). */
  private async pricing(payload: SpreadChangePayload): Promise<PairPricing> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT spread_basis_points, minimum_source_amount_minor::text AS minimum_source_amount_minor
         FROM currency_pairs WHERE source_currency_code = $1 AND target_currency_code = $2`,
      [payload.sourceCurrency, payload.targetCurrency],
    )) as { spread_basis_points: number; minimum_source_amount_minor: string }[];
    if (!row) {
      throw new ActionPreconditionFailedError('PAIR_NOT_FOUND', 'No such currency pair.', {
        sourceCurrency: payload.sourceCurrency,
        targetCurrency: payload.targetCurrency,
      });
    }
    return { spreadBasisPoints: row.spread_basis_points, minimumSourceAmountMinor: row.minimum_source_amount_minor };
  }
}
