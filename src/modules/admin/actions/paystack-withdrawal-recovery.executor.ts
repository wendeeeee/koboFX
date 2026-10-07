import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { FlowRepository } from '../../flows/flow.repository';
import { PaystackWithdrawalState } from '../../flows/paystack-withdrawal/paystack-withdrawal-transitions';
import { BreakStatus, ResolutionKind } from '../../reconciliation/break-transitions';
import { BreakService } from '../../reconciliation/break.service';
import { ApprovedRecoveryContext, VerifiedTransferFacts, WithdrawalFlow, WithdrawalRecord } from '../../withdrawals/withdrawal-flow';
import { ActionPreconditionFailedError } from '../admin.errors';
import { ApprovalActionType } from '../approvals/approval.types';
import { WithdrawalRecoveryMode, WithdrawalRecoveryPayload } from './action-payloads';
import { ActionExecutor, ExecutionContext } from './action-registry';
import { assertValueTimeBookable } from './value-time';

/** Stored evidence older than this is refused: the worker must re-verify first (no HTTP inside an approval). */
export const RECOVERY_EVIDENCE_MAXIMUM_AGE_HOURS = 24;

const SUCCESS_MODES: readonly WithdrawalRecoveryMode[] = [WithdrawalRecoveryMode.COMPLETE_MATCHED_SUCCESS, WithdrawalRecoveryMode.LATE_FACT_POST];
const UNRESOLVED_SENT: readonly string[] = [PaystackWithdrawalState.SUBMITTING, PaystackWithdrawalState.PROCESSING];

interface ObservationRow {
  id: string;
  withdrawal_id: string | null;
  operation: string;
  status_classification: string;
  observed_domain: string | null;
  provider_reference: string | null;
  provider_transfer_id: string | null;
  provider_transfer_code: string | null;
  amount_minor: string | null;
  currency_code: string | null;
  recipient_identity_fingerprint: Buffer | null;
  recipient_identity_fingerprint_key_id: string | null;
  provider_transferred_at: Date | null;
  fee_charged_minor: string | null;
  observed_at: Date;
  age_seconds: number;
}

const refuse = (reason: string, message: string, details: Record<string, unknown> = {}): never => {
  throw new ActionPreconditionFailedError(reason, message, details);
};

/**
 * PAYSTACK_WITHDRAWAL_RECOVERY (WITHDRAWAL_PLAN.md §I.3; D7): apply a STORED, matched Paystack transfer outcome to a
 * withdrawal — four-eyes, never break-glass, database only (it never sends a transfer and never calls Paystack: the
 * worker prepared the evidence; stale evidence is refused and must be refreshed by a run).
 *
 * Re-validated under the approver's locks, in order (approval → owner → flow → withdrawal → accounts): the break is live
 * and about this withdrawal; the observation is this withdrawal's, from `transfer.verify`, with the right classification
 * and the exact identity (reference, amount, currency, `test` domain, recipient fingerprint, bound transfer) and no older
 * than `RECOVERY_EVIDENCE_MAXIMUM_AGE_HOURS`; the mode fits the state (an already recovered withdrawal is a refusal,
 * never a second effect); no worker holds the flow's lease; the value time is in an open period. Then the SAME
 * primitives the flow uses (`applyVerifiedSuccess` / `applyFullReturn`) with the stored observation. A FAILED
 * withdrawal's late success posts its principal through `post()` (the released hold is never "settled") under the
 * database's guarded FAILED → POSTED edge, which accepts only this executing approval (`fx.withdrawal_recovery`). The
 * break is resolved `RECOVERY_APPLIED`, reference `approval:{id}`.
 */
@Injectable()
export class PaystackWithdrawalRecoveryExecutor implements ActionExecutor<ApprovalActionType.PAYSTACK_WITHDRAWAL_RECOVERY> {
  readonly actionType = ApprovalActionType.PAYSTACK_WITHDRAWAL_RECOVERY;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly breaks: BreakService,
    private readonly flows: FlowRepository,
    private readonly moduleRef: ModuleRef,
  ) {}

  async validateRequest(payload: WithdrawalRecoveryPayload): Promise<void> {
    await this.check(payload);
  }

  async execute(payload: WithdrawalRecoveryPayload, context: ExecutionContext): Promise<string> {
    const { state, record, observation, valueTime } = await this.check(payload);
    const flow = this.withdrawalFlow();
    const manager = this.unitOfWork.requireTransaction();
    // The pointer the database's recovery guards read; they accept it only while this approval is APPROVED (executing).
    await manager.query(`SELECT set_config('fx.withdrawal_recovery', $1, true)`, [context.approvalId]);
    const success = SUCCESS_MODES.includes(payload.mode);
    const lateFact = payload.mode === WithdrawalRecoveryMode.LATE_FACT_POST || payload.mode === WithdrawalRecoveryMode.LATE_FACT_RETURN;
    const recovery: ApprovedRecoveryContext = {
      approvalId: context.approvalId,
      executedBy: context.executedBy,
      valueTime: lateFact ? valueTime : null,
      lateSuccess: success && state === PaystackWithdrawalState.FAILED,
    };
    const facts: VerifiedTransferFacts = {
      observationId: observation.id,
      observedAt: observation.observed_at,
      transferId: observation.provider_transfer_id,
      transferredAt: observation.provider_transferred_at,
      feeChargedMinor: observation.fee_charged_minor === null ? null : BigInt(observation.fee_charged_minor),
    };
    let reference = '';
    await this.flows.applyApproved(
      payload.withdrawalId,
      state,
      {
        to: success ? PaystackWithdrawalState.POSTED : PaystackWithdrawalState.REVERSED,
        complete: true,
        note: `approved recovery ${context.approvalId} (${payload.mode})`,
      },
      async (locked) => {
        await flow.lockWithdrawal(locked, record.flow_id);
        if (success) {
          if (record.provider_transfer_id === null && observation.provider_transfer_id && observation.provider_transfer_code) {
            await locked.query(
              `UPDATE paystack_withdrawals SET provider_transfer_id = $2, provider_transfer_code = $3 WHERE flow_id = $1 AND provider_transfer_id IS NULL`,
              [record.flow_id, observation.provider_transfer_id, observation.provider_transfer_code],
            );
          }
          reference = await flow.applyVerifiedSuccess(locked, record, state, facts, recovery);
        } else {
          reference = await flow.applyFullReturn(locked, record, facts, recovery);
        }
      },
    );
    const resolved = await this.breaks.resolve(
      payload.breakId,
      `operator:${context.executedBy}`,
      ResolutionKind.RECOVERY_APPLIED,
      `approval:${context.approvalId}`,
      context.reason,
    );
    if (!resolved) refuse('BREAK_NOT_LIVE', 'The break was resolved meanwhile.', { breakId: payload.breakId });
    await manager.query(`SELECT set_config('fx.withdrawal_recovery', '', true)`);
    return reference;
  }

  /** Everything that must hold, read now (execution re-reads under the approver's transaction; the flow lock re-checks state). */
  private async check(payload: WithdrawalRecoveryPayload): Promise<{ state: string; record: WithdrawalRecord; observation: ObservationRow; valueTime: Date }> {
    const live = await this.breaks.findById(payload.breakId);
    if (!live) refuse('BREAK_NOT_FOUND', 'No such break.', { breakId: payload.breakId });
    if (live!.status === BreakStatus.RESOLVED) refuse('BREAK_NOT_LIVE', 'The break is already resolved.', { breakId: payload.breakId });
    if (live!.flowId !== payload.withdrawalId) refuse('BREAK_NOT_ABOUT_WITHDRAWAL', 'The break is not about this withdrawal.', { breakId: payload.breakId });

    const [flowRow] = (await this.unitOfWork.manager.query(
      `SELECT flow_instances.state FROM flow_instances JOIN paystack_withdrawals ON paystack_withdrawals.flow_id = flow_instances.id
        WHERE flow_instances.id = $1`,
      [payload.withdrawalId],
    )) as { state: string }[];
    if (!flowRow) refuse('WITHDRAWAL_NOT_FOUND', 'No such withdrawal.', { withdrawalId: payload.withdrawalId });
    const state = flowRow.state;
    const success = SUCCESS_MODES.includes(payload.mode);
    if (success && (state === PaystackWithdrawalState.POSTED || state === PaystackWithdrawalState.REVERSED)) {
      refuse('ALREADY_RECOVERED', 'The withdrawal is already posted: nothing to recover, nothing is applied twice.', { state });
    }
    if (!success && state === PaystackWithdrawalState.REVERSED) {
      refuse('ALREADY_RECOVERED', 'The withdrawal is already reversed: nothing is applied twice.', { state });
    }
    const fits = success ? UNRESOLVED_SENT.includes(state) || state === PaystackWithdrawalState.FAILED : state === PaystackWithdrawalState.POSTED;
    if (!fits) refuse('WRONG_MODE_FOR_STATE', `Mode ${payload.mode} does not apply to a ${state} withdrawal.`, { state, mode: payload.mode });

    const record = await this.withdrawalFlow().load(payload.withdrawalId);
    const [observation] = (await this.unitOfWork.manager.query(
      `SELECT id, withdrawal_id, operation, status_classification::text AS status_classification, observed_domain, provider_reference,
              provider_transfer_id, provider_transfer_code, amount_minor::text AS amount_minor, currency_code,
              recipient_identity_fingerprint, recipient_identity_fingerprint_key_id, provider_transferred_at,
              fee_charged_minor::text AS fee_charged_minor, observed_at,
              extract(epoch FROM now() - observed_at)::float8 AS age_seconds
         FROM paystack_transfer_observations WHERE id = $1`,
      [payload.observationId],
    )) as ObservationRow[];
    if (!observation || observation.withdrawal_id !== payload.withdrawalId) {
      refuse('OBSERVATION_NOT_OF_WITHDRAWAL', 'The observation is not one of this withdrawal\'s.', { observationId: payload.observationId });
    }
    if (observation.operation !== 'transfer.verify') {
      refuse('OBSERVATION_NOT_VERIFY', 'Only a transfer.verify observation can establish an outcome.', { operation: observation.operation });
    }
    const wanted = success ? 'SUCCESS' : 'REVERSED';
    if (observation.status_classification !== wanted) {
      refuse('OBSERVATION_WRONG_OUTCOME', `Mode ${payload.mode} needs a ${wanted} observation.`, { classification: observation.status_classification });
    }
    const [destination] = (await this.unitOfWork.manager.query(
      `SELECT identity_fingerprint, identity_fingerprint_key_id FROM withdrawal_destinations WHERE withdrawal_id = $1`,
      [payload.withdrawalId],
    )) as { identity_fingerprint: Buffer; identity_fingerprint_key_id: string }[];
    const matches =
      observation.provider_reference === record.provider_reference &&
      observation.amount_minor === record.principal_minor &&
      observation.currency_code === record.currency_code &&
      observation.observed_domain === 'test' &&
      observation.provider_transfer_id !== null &&
      (record.provider_transfer_id === null || observation.provider_transfer_id === record.provider_transfer_id) &&
      (record.provider_transfer_code === null || observation.provider_transfer_code === record.provider_transfer_code) &&
      observation.recipient_identity_fingerprint !== null &&
      observation.recipient_identity_fingerprint.equals(destination.identity_fingerprint) &&
      observation.recipient_identity_fingerprint_key_id === destination.identity_fingerprint_key_id;
    if (!matches) refuse('OBSERVATION_MISMATCH', 'The observation does not match the withdrawal\'s identity.', { observationId: observation.id });
    if (observation.age_seconds > RECOVERY_EVIDENCE_MAXIMUM_AGE_HOURS * 3600) {
      refuse('OBSERVATION_STALE', `The evidence is older than ${RECOVERY_EVIDENCE_MAXIMUM_AGE_HOURS}h: refresh it with a reconciliation run first.`, {
        observationId: observation.id,
        observedAt: observation.observed_at.toISOString(),
      });
    }

    const lateFact = 'valueTime' in payload;
    const valueTime = lateFact ? new Date(payload.valueTime) : (success ? observation.provider_transferred_at : null) ?? observation.observed_at;
    await assertValueTimeBookable(this.unitOfWork, valueTime);
    return { state, record, observation, valueTime };
  }

  /** Present wherever a Paystack key is configured (withdrawal work can exist); absent ⇒ nothing to recover here. */
  private withdrawalFlow(): WithdrawalFlow {
    const flow = this.moduleRef.get(WithdrawalFlow, { strict: false }) as WithdrawalFlow | undefined;
    if (!flow) refuse('WITHDRAWALS_NOT_CONFIGURED', 'Withdrawal recovery needs the Paystack transfers configuration.');
    return flow!;
  }
}
