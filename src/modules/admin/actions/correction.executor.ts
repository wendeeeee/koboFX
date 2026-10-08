import { Injectable } from '@nestjs/common';
import { Money } from '../../../common/money';
import { constraintName, sqlState } from '../../../database/database-errors';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { AuditAction, AuditLogService, AuditSubjectType } from '../../audit/audit-log.service';
import { FundingPaymentRepository } from '../../flows/funding/funding-payment.repository';
import { ChartOfAccountsService } from '../../ledger/chart-of-accounts.service';
import { LedgerService } from '../../ledger/ledger.service';
import { LedgerEntryDraft, PostingAuthorization, TransactionType } from '../../ledger/ledger.types';
import { BreakType } from '../../reconciliation/break-types';
import { BreakStatus, ResolutionKind } from '../../reconciliation/break-transitions';
import { BreakService, ReconciliationBreak } from '../../reconciliation/break.service';
import { UserStatus } from '../../users/user.types';
import { ActionPreconditionFailedError } from '../admin.errors';
import { ApprovalActionType } from '../approvals/approval.types';
import { CorrectionMode, CorrectionPayload } from './action-payloads';
import { ActionExecutor, ExecutionContext } from './action-registry';
import { assertValueTimeBookable } from './value-time';
import {
  clearingToPayableEntries,
  clearingToUserEntries,
  partialChargebackEntries,
  settleDepositFromClearingEntries,
} from './correction-posting';

/** Which breaks each correction may fix (Phase 10 plan §E.4). */
export const CORRECTABLE_BREAKS: Readonly<Record<CorrectionMode, readonly BreakType[]>> = {
  [CorrectionMode.CLEARING_TO_USER]: [BreakType.PAYMENT_WITHOUT_FLOW, BreakType.UNATTRIBUTED_SETTLEMENT_LINE],
  [CorrectionMode.SETTLE_DEPOSIT_FROM_CLEARING]: [BreakType.AMOUNT_MISMATCH, BreakType.MISSING_IN_LEDGER],
  [CorrectionMode.CLEARING_TO_PSP_PAYABLE]: [
    BreakType.DUPLICATE_SETTLEMENT_LINE,
    BreakType.UNATTRIBUTED_SETTLEMENT_LINE,
    BreakType.PAYMENT_WITHOUT_FLOW,
    BreakType.CURRENCY_MISMATCH,
  ],
  [CorrectionMode.PARTIAL_CHARGEBACK]: [BreakType.CHARGEBACK_NOT_REVERSED],
};

/** Stable `reason_code`s of the postings (user-visible ones are in `PUBLIC_REASON_CODES`). */
export const CORRECTION_REASON_CODES: Readonly<Record<CorrectionMode, string>> = {
  [CorrectionMode.CLEARING_TO_USER]: 'CLEARING_REATTRIBUTION',
  [CorrectionMode.SETTLE_DEPOSIT_FROM_CLEARING]: 'SETTLEMENT_AMOUNT_CORRECTION',
  [CorrectionMode.CLEARING_TO_PSP_PAYABLE]: 'DUPLICATE_SETTLEMENT_REFUND',
  [CorrectionMode.PARTIAL_CHARGEBACK]: 'PARTIAL_CHARGEBACK',
};

interface SettlementLine {
  readonly id: string;
  readonly lineType: 'PAYMENT' | 'CHARGEBACK';
  readonly attribution: 'ATTRIBUTED' | 'CLEARING';
  readonly amountMinor: bigint;
  readonly feeMinor: bigint;
  readonly currency: string;
  readonly settledAt: Date;
  readonly settlementTransactionId: string;
  readonly corrected: boolean;
}

interface Deposit {
  readonly flowId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly amount: Money;
  readonly fundingTransactionId: string;
  readonly settled: boolean;
  readonly chargebackTransactionId: string | null;
  readonly corrected: boolean;
}

/** What a correction will post, decided from the world as it is at the moment of inspection. */
interface CorrectionPlan {
  readonly broken: ReconciliationBreak;
  readonly correctsTransactionId: string;
  readonly correctionSubject?: string;
  readonly userId?: string;
  readonly externalReference?: string;
  readonly entries: LedgerEntryDraft[];
  readonly line?: SettlementLine;
  readonly deposit?: Deposit;
}

const refuse = (reason: string, message: string, details: Record<string, unknown> = {}) => new ActionPreconditionFailedError(reason, message, details);

/**
 * CORRECTION (design §5.4, §8.2 "drift is never fixed by overwriting"; Phase 9 decision 3: CLEARING money leaves
 * only by a CORRECTION). A new, linked, compensating posting through `post()` — never an edit — which resolves its
 * break `CORRECTION_POSTED` citing the approval. The value time is the payload's: refused in a locked period, never
 * re-dated. One correction per subject, by construction (the ledger's partial unique index, the line link's key).
 */
@Injectable()
export class CorrectionExecutor implements ActionExecutor<ApprovalActionType.CORRECTION> {
  readonly actionType = ApprovalActionType.CORRECTION;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ledger: LedgerService,
    private readonly chartOfAccounts: ChartOfAccountsService,
    private readonly breaks: BreakService,
    private readonly fundingPayments: FundingPaymentRepository,
    private readonly audit: AuditLogService,
  ) {}

  async validateRequest(payload: CorrectionPayload): Promise<void> {
    await this.plan(payload, false);
  }

  async execute(payload: CorrectionPayload, context: ExecutionContext): Promise<string> {
    const plan = await this.plan(payload, true);
    const manager = this.unitOfWork.requireTransaction();
    const posted = await this.ledger.post({
      transaction: {
        type: TransactionType.CORRECTION,
        authorization: PostingAuthorization.SYSTEM_DRIVEN,
        valueTime: new Date(payload.valueTime),
        initiatedBy: `operator:${context.requestedBy}`,
        reference: `approval:${context.approvalId}`,
        reasonCode: CORRECTION_REASON_CODES[payload.mode],
        correctsTransactionId: plan.correctsTransactionId,
        ...(plan.correctionSubject ? { correctionSubject: plan.correctionSubject } : {}),
        ...(plan.userId ? { userId: plan.userId } : {}),
        ...(plan.externalReference ? { externalReference: plan.externalReference } : {}),
        metadata: {
          approvalId: context.approvalId,
          breakId: plan.broken.id,
          mode: payload.mode,
          requestedBy: context.requestedBy,
          approvedBy: context.executedBy,
          ...(plan.line ? { settlementBatchLineId: plan.line.id } : {}),
        },
      },
      entries: plan.entries,
    });

    if (plan.line) {
      try {
        await manager.query(
          `INSERT INTO settlement_line_corrections (settlement_batch_line_id, transaction_id, approval_id) VALUES ($1, $2, $3)`,
          [plan.line.id, posted.transactionId, context.approvalId],
        );
      } catch (error) {
        if (sqlState(error) === '23505' && constraintName(error) === 'settlement_line_corrections_pkey') {
          throw refuse('LINE_ALREADY_CORRECTED', 'This settlement line was corrected meanwhile.', { settlementBatchLineId: plan.line.id });
        }
        throw error;
      }
    }
    if (payload.mode === CorrectionMode.SETTLE_DEPOSIT_FROM_CLEARING && plan.deposit && plan.line) {
      const recorded = await this.fundingPayments.recordSettlement(manager, plan.deposit.flowId, {
        settlementBatchLineId: plan.line.id,
        settledAt: plan.line.settledAt,
        feeMinor: plan.line.feeMinor,
      });
      if (!recorded) throw refuse('DEPOSIT_ALREADY_SETTLED', 'The deposit was settled meanwhile.', { flowId: plan.deposit.flowId });
    }
    if (payload.mode === CorrectionMode.PARTIAL_CHARGEBACK && plan.deposit) {
      // The chargeback is booked: the flow stops re-parking it, the chargeback scan stops re-detecting it.
      await this.fundingPayments.update(manager, plan.deposit.flowId, { chargebackTransactionId: posted.transactionId });
    }

    const resolved = await this.breaks.resolve(
      plan.broken.id,
      `operator:${context.executedBy}`,
      ResolutionKind.CORRECTION_POSTED,
      `approval:${context.approvalId}`,
      `${CORRECTION_REASON_CODES[payload.mode]} posted as transaction ${posted.transactionId}`,
    );
    if (!resolved) throw refuse('BREAK_NOT_LIVE', 'The break was resolved meanwhile.', { breakId: plan.broken.id });

    await this.audit.record({
      actor: { type: 'OPERATOR', id: context.executedBy },
      action: AuditAction.CORRECTION_POSTED,
      subject: { type: AuditSubjectType.TRANSACTION, id: posted.transactionId },
      after: { transactionId: posted.transactionId, approvalId: context.approvalId, breakId: plan.broken.id, actionType: this.actionType },
      reason: context.reason,
    });
    return posted.transactionId;
  }

  /** Everything the correction needs, read and checked now (request time, and again at execution). */
  private async plan(payload: CorrectionPayload, forExecution: boolean): Promise<CorrectionPlan> {
    const broken = await this.breaks.findById(payload.breakId);
    if (!broken) throw refuse('BREAK_NOT_FOUND', 'No such break.', { breakId: payload.breakId });
    if (broken.status === BreakStatus.RESOLVED) throw refuse('BREAK_NOT_LIVE', 'The break is already resolved.', { breakId: broken.id });
    if (!CORRECTABLE_BREAKS[payload.mode].includes(broken.type)) {
      throw refuse('BREAK_TYPE_NOT_CORRECTABLE', `A ${payload.mode} correction does not fix a ${broken.type} break.`, {
        breakId: broken.id,
        breakType: broken.type,
      });
    }
    await assertValueTimeBookable(this.unitOfWork, new Date(payload.valueTime));

    switch (payload.mode) {
      case CorrectionMode.CLEARING_TO_USER: {
        const line = await this.clearingLine(broken, 'PAYMENT');
        const account = await this.userAccount(payload.userId, line.currency, forExecution);
        return {
          broken,
          line,
          correctsTransactionId: line.settlementTransactionId,
          correctionSubject: `line:${line.id}`,
          userId: payload.userId,
          entries: clearingToUserEntries(Money.of(line.amountMinor, line.currency), account),
        };
      }
      case CorrectionMode.CLEARING_TO_PSP_PAYABLE: {
        const line = await this.clearingLine(broken, 'PAYMENT');
        return {
          broken,
          line,
          correctsTransactionId: line.settlementTransactionId,
          correctionSubject: `line:${line.id}`,
          entries: clearingToPayableEntries(Money.of(line.amountMinor, line.currency)),
        };
      }
      case CorrectionMode.SETTLE_DEPOSIT_FROM_CLEARING: {
        if (broken.type === BreakType.MISSING_IN_LEDGER && broken.details.settledIntoClearing !== true) {
          throw refuse('NO_MONEY_IN_CLEARING', 'This break did not put a settlement line in CLEARING.', { breakId: broken.id });
        }
        const line = await this.clearingLine(broken, 'PAYMENT');
        const deposit = await this.deposit(broken);
        if (deposit.settled) throw refuse('DEPOSIT_ALREADY_SETTLED', 'The deposit is already settled.', { flowId: deposit.flowId });
        if (deposit.chargebackTransactionId) throw refuse('DEPOSIT_CHARGED_BACK', 'The deposit was charged back.', { flowId: deposit.flowId });
        if (deposit.amount.currency !== line.currency) {
          throw refuse('CURRENCY_MISMATCH', 'The line is in another currency than the deposit.', { flowId: deposit.flowId });
        }
        return {
          broken,
          line,
          deposit,
          correctsTransactionId: deposit.fundingTransactionId,
          userId: deposit.userId,
          entries: settleDepositFromClearingEntries(Money.of(line.amountMinor, line.currency), deposit.amount, deposit.accountId),
        };
      }
      case CorrectionMode.PARTIAL_CHARGEBACK: {
        if (broken.details.partial !== true) {
          throw refuse('NOT_A_PARTIAL_CHARGEBACK', 'A full chargeback is reversed through its flow, not corrected.', { breakId: broken.id });
        }
        const deposit = await this.deposit(broken);
        if (deposit.chargebackTransactionId) throw refuse('CHARGEBACK_ALREADY_BOOKED', 'The chargeback is already booked.', { flowId: deposit.flowId });
        const disputed = Money.of(broken.amountMinor, deposit.amount.currency);
        if (disputed.amountMinor <= 0n || disputed.amountMinor >= deposit.amount.amountMinor) {
          throw refuse('NOT_A_PARTIAL_CHARGEBACK', 'The disputed amount is not part of the deposit.', { breakId: broken.id });
        }
        const chargebackId = typeof broken.details.chargebackId === 'string' ? broken.details.chargebackId : undefined;
        if (!chargebackId) throw refuse('CHARGEBACK_UNIDENTIFIED', 'The break does not name the dispute.', { breakId: broken.id });
        // Already deducted by the PSP (a deduction line in CLEARING)? Then CLEARING, else the receivable. The line may
        // be on the break, or — when the chargeback scan raised the break first — found by the dispute's own id.
        const line = broken.settlementBatchLineId
          ? await this.clearingLine(broken, 'CHARGEBACK')
          : await this.deductionLine(broken, deposit.flowId, chargebackId);
        if (line && line.amountMinor !== disputed.amountMinor) {
          throw refuse('AMOUNT_MISMATCH', 'The deduction line and the dispute disagree.', { breakId: broken.id });
        }
        return {
          broken,
          deposit,
          ...(line ? { line } : {}),
          correctsTransactionId: deposit.fundingTransactionId,
          userId: deposit.userId,
          externalReference: chargebackId,
          entries: partialChargebackEntries(disputed, deposit.accountId, line ? 'CLEARING' : 'PSP_RECEIVABLE'),
        };
      }
    }
  }

  private async clearingLine(broken: ReconciliationBreak, lineType: SettlementLine['lineType']): Promise<SettlementLine> {
    if (!broken.settlementBatchLineId) {
      throw refuse('NO_MONEY_IN_CLEARING', 'This break has no settlement line: no money reached CLEARING.', { breakId: broken.id });
    }
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT settlement_batch_lines.id, settlement_batch_lines.line_type, settlement_batch_lines.attribution,
              settlement_batch_lines.amount_minor::text AS amount_minor, settlement_batch_lines.fee_minor::text AS fee_minor,
              settlement_batches.currency_code, settlement_batches.settled_at, settlement_batches.settlement_transaction_id,
              EXISTS (SELECT 1 FROM settlement_line_corrections
                       WHERE settlement_line_corrections.settlement_batch_line_id = settlement_batch_lines.id) AS corrected
         FROM settlement_batch_lines JOIN settlement_batches ON settlement_batches.id = settlement_batch_lines.batch_id
        WHERE settlement_batch_lines.id = $1`,
      [broken.settlementBatchLineId],
    )) as {
      id: string;
      line_type: SettlementLine['lineType'];
      attribution: SettlementLine['attribution'];
      amount_minor: string;
      fee_minor: string;
      currency_code: string;
      settled_at: Date;
      settlement_transaction_id: string | null;
      corrected: boolean;
    }[];
    if (!row || !row.settlement_transaction_id) throw refuse('NO_MONEY_IN_CLEARING', 'The settlement line was never posted.', { breakId: broken.id });
    if (row.attribution !== 'CLEARING' || row.line_type !== lineType) {
      throw refuse('NO_MONEY_IN_CLEARING', `The line is not a ${lineType} line held in CLEARING.`, { settlementBatchLineId: row.id });
    }
    if (row.corrected) throw refuse('LINE_ALREADY_CORRECTED', 'This settlement line is already corrected.', { settlementBatchLineId: row.id });
    return {
      id: row.id,
      lineType: row.line_type,
      attribution: row.attribution,
      amountMinor: BigInt(row.amount_minor),
      feeMinor: BigInt(row.fee_minor),
      currency: row.currency_code.trim(),
      settledAt: row.settled_at,
      settlementTransactionId: row.settlement_transaction_id,
      corrected: row.corrected,
    };
  }

  /** An uncorrected CLEARING deduction line for this dispute, if the PSP already deducted it. */
  private async deductionLine(broken: ReconciliationBreak, flowId: string, chargebackId: string): Promise<SettlementLine | undefined> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT settlement_batch_lines.id FROM settlement_batch_lines
        WHERE settlement_batch_lines.flow_id = $1 AND settlement_batch_lines.provider_chargeback_id = $2
          AND settlement_batch_lines.line_type = 'CHARGEBACK' AND settlement_batch_lines.attribution = 'CLEARING'
          AND NOT EXISTS (SELECT 1 FROM settlement_line_corrections
                           WHERE settlement_line_corrections.settlement_batch_line_id = settlement_batch_lines.id)
        ORDER BY settlement_batch_lines.id LIMIT 1`,
      [flowId, chargebackId],
    )) as { id: string }[];
    return row ? this.clearingLine({ ...broken, settlementBatchLineId: row.id }, 'CHARGEBACK') : undefined;
  }

  private async deposit(broken: ReconciliationBreak): Promise<Deposit> {
    if (!broken.flowId) throw refuse('NO_DEPOSIT', 'The break names no deposit of ours.', { breakId: broken.id });
    const payment = await this.fundingPayments.findByFlowId(broken.flowId);
    if (!payment?.fundingTransactionId) throw refuse('DEPOSIT_NOT_BOOKED', 'The deposit is not in the ledger.', { flowId: broken.flowId });
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT funding_payments.settlement_batch_line_id IS NOT NULL AS settled,
              transactions.corrected_by_transaction_id IS NOT NULL OR transactions.status <> 'POSTED' AS corrected
         FROM funding_payments JOIN transactions ON transactions.id = funding_payments.funding_transaction_id
        WHERE funding_payments.flow_id = $1`,
      [broken.flowId],
    )) as { settled: boolean; corrected: boolean }[];
    if (row?.corrected) throw refuse('ALREADY_CORRECTED', 'The deposit is already corrected or reversed.', { flowId: broken.flowId });
    return {
      flowId: payment.flowId,
      userId: payment.userId,
      accountId: payment.accountId,
      amount: payment.amount,
      fundingTransactionId: payment.fundingTransactionId,
      settled: row?.settled ?? false,
      chargebackTransactionId: payment.chargebackTransactionId,
      corrected: row?.corrected ?? false,
    };
  }

  /**
   * The user's account in the line's currency; the user must be verified. Opened (if new) only at execution —
   * a request that is never approved leaves nothing behind.
   */
  private async userAccount(userId: string, currency: string, open: boolean): Promise<string> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT users.status, wallets.id AS wallet_id FROM users JOIN wallets ON wallets.user_id = users.id WHERE users.id = $1`,
      [userId],
    )) as { status: UserStatus; wallet_id: string }[];
    if (!row) throw refuse('USER_NOT_FOUND', 'No such user.', { userId });
    if (row.status === UserStatus.PENDING_VERIFICATION) throw refuse('USER_NOT_VERIFIED', 'The user has not verified their account.', { userId });
    if (!open) return row.wallet_id;
    return (await this.chartOfAccounts.openUserAccount(row.wallet_id, currency)).id;
  }
}
