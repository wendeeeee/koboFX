import { Injectable } from '@nestjs/common';
import { Money } from '../../../common/money';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { AuditAction, AuditLogService, AuditSubjectType } from '../../audit/audit-log.service';
import { LedgerService } from '../../ledger/ledger.service';
import { PostingAuthorization, TransactionType } from '../../ledger/ledger.types';
import { ActionPreconditionFailedError } from '../admin.errors';
import { ApprovalActionType } from '../approvals/approval.types';
import { WriteOffPayload } from './action-payloads';
import { ActionExecutor, ExecutionContext } from './action-registry';
import { writeOffEntries } from './correction-posting';
import { assertValueTimeBookable } from './value-time';

export const WRITE_OFF_REASON_CODE = 'WRITE_OFF';

/**
 * WRITE_OFF of an unrecoverable overdraft (design §6.4; Phase 10 plan §E.5). "Unrecoverable" is the operators'
 * judgement, documented in the approval's reason; what the system requires is re-read at execution under the
 * account's row lock: the balance is negative and the write-off does not exceed it (partial is fine). A deposit
 * that landed since the request shrinks the overdraft — a write-off that no longer fits is refused, never
 * clamped. No receivable is kept (a later recovery is out of scope, recorded).
 */
@Injectable()
export class WriteOffExecutor implements ActionExecutor<ApprovalActionType.WRITE_OFF> {
  readonly actionType = ApprovalActionType.WRITE_OFF;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ledger: LedgerService,
    private readonly audit: AuditLogService,
  ) {}

  async validateRequest(payload: WriteOffPayload): Promise<void> {
    await assertValueTimeBookable(this.unitOfWork, new Date(payload.valueTime));
    const account = await this.account(payload);
    this.assertFits(payload, account.balanceMinor);
  }

  async execute(payload: WriteOffPayload, context: ExecutionContext): Promise<string> {
    await assertValueTimeBookable(this.unitOfWork, new Date(payload.valueTime));
    const account = await this.account(payload);
    const locked = await this.ledger.lockUserAccounts([account.id]);
    const balance = locked.get(account.id)?.balanceMinor ?? account.balanceMinor;
    this.assertFits(payload, balance);
    const posted = await this.ledger.post({
      transaction: {
        type: TransactionType.WRITE_OFF,
        authorization: PostingAuthorization.SYSTEM_DRIVEN,
        valueTime: new Date(payload.valueTime),
        initiatedBy: `operator:${context.requestedBy}`,
        reference: `approval:${context.approvalId}`,
        userId: payload.userId,
        reasonCode: WRITE_OFF_REASON_CODE,
        metadata: { approvalId: context.approvalId, requestedBy: context.requestedBy, approvedBy: context.executedBy },
      },
      entries: writeOffEntries(Money.fromMinorString(payload.amount, payload.currency), account.id),
    });
    await this.audit.record({
      actor: { type: 'OPERATOR', id: context.executedBy },
      action: AuditAction.WRITE_OFF_POSTED,
      subject: { type: AuditSubjectType.TRANSACTION, id: posted.transactionId },
      after: { transactionId: posted.transactionId, approvalId: context.approvalId, actionType: this.actionType },
      reason: context.reason,
    });
    return posted.transactionId;
  }

  private assertFits(payload: WriteOffPayload, balanceMinor: bigint): void {
    if (balanceMinor >= 0n) {
      throw new ActionPreconditionFailedError('ACCOUNT_NOT_OVERDRAWN', 'The account is not overdrawn.', { balance: balanceMinor.toString() });
    }
    if (BigInt(payload.amount) > -balanceMinor) {
      throw new ActionPreconditionFailedError('WRITE_OFF_EXCEEDS_OVERDRAFT', 'The write-off is larger than the overdraft.', {
        amount: payload.amount,
        overdraft: (-balanceMinor).toString(),
      });
    }
  }

  private async account(payload: WriteOffPayload): Promise<{ id: string; balanceMinor: bigint }> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT accounts.id, accounts.balance_minor::text AS balance_minor
         FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id
        WHERE wallets.user_id = $1 AND accounts.currency_code = $2`,
      [payload.userId, payload.currency],
    )) as { id: string; balance_minor: string }[];
    if (!row) throw new ActionPreconditionFailedError('ACCOUNT_NOT_FOUND', 'The user has no account in that currency.', { userId: payload.userId });
    return { id: row.id, balanceMinor: BigInt(row.balance_minor) };
  }
}
