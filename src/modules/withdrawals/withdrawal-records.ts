import { Injectable } from '@nestjs/common';
import { SealingContext } from '../../common/crypto/sealing';
import { AuditAction, AuditActor, AuditLogService, AuditSubjectType } from '../audit/audit-log.service';
import { OutboxService } from '../outbox/outbox.service';
import { OutboxEventType, WithdrawalFlowChangedPayload } from '../outbox/outbox.types';

export const WITHDRAWAL_INITIATED_BY = 'job:paystack-withdrawal-flow';
export const PAYSTACK_PROVIDER = 'paystack';
export const RECIPIENT_TYPE = 'nuban';
export const WITHDRAWAL_CURRENCY = 'NGN';

export type BeneficiaryColumn =
  | 'account_number_sealed'
  | 'resolved_account_name_sealed'
  | 'provider_recipient_code_sealed'
  | 'provider_recipient_id_sealed';


export function beneficiaryContext(beneficiaryId: string, userId: string, column: BeneficiaryColumn): SealingContext {
  return { table: 'withdrawal_beneficiaries', column, rowId: beneficiaryId, ownerId: userId, provider: PAYSTACK_PROVIDER };
}

export function maskedAccountNumber(lastFour: string): string {
  return `******${lastFour}`;
}


@Injectable()
export class WithdrawalTrail {
  constructor(
    private readonly audit: AuditLogService,
    private readonly outbox: OutboxService,
  ) {}

  async requested(kind: 'BENEFICIARY' | 'WITHDRAWAL', flowId: string, userId: string, state: string): Promise<void> {
    await this.audit.record({
      actor: { type: 'USER', id: userId },
      action: kind === 'BENEFICIARY' ? AuditAction.BENEFICIARY_REQUESTED : AuditAction.WITHDRAWAL_REQUESTED,
      subject: { type: AuditSubjectType.FLOW, id: flowId },
      after: { flowState: state },
      reason: kind === 'BENEFICIARY' ? 'user added a withdrawal beneficiary' : 'user requested a Paystack withdrawal',
    });
    await this.event(kind, flowId, userId, state);
  }

  async changed(
    kind: 'BENEFICIARY' | 'WITHDRAWAL',
    flowId: string,
    userId: string,
    from: string,
    to: string,
    details: { failureCode?: string; transactionId?: string } = {},
    actor: AuditActor = { type: 'SYSTEM' },
  ): Promise<void> {
    await this.audit.record({
      actor,
      action: kind === 'BENEFICIARY' ? AuditAction.BENEFICIARY_STATE_CHANGED : AuditAction.WITHDRAWAL_STATE_CHANGED,
      subject: { type: AuditSubjectType.FLOW, id: flowId },
      before: { flowState: from },
      after: { flowState: to, ...details },
      reason: kind === 'BENEFICIARY' ? 'beneficiary preparation progressed' : 'withdrawal progressed',
    });
    await this.event(kind, flowId, userId, to);
  }

  private async event(kind: 'BENEFICIARY' | 'WITHDRAWAL', flowId: string, userId: string, state: string): Promise<void> {
    const payload: WithdrawalFlowChangedPayload = { flowId, userId, state };
    await this.outbox.enqueue(kind === 'BENEFICIARY' ? OutboxEventType.BENEFICIARY_CHANGED : OutboxEventType.WITHDRAWAL_CHANGED, flowId, payload);
  }
}
