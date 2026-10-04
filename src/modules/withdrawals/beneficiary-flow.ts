import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InvariantViolationError } from '../../common/errors';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { FlowRunner } from '../flows/flow-runner';
import { ClaimedFlow, FlowCheckpoint, FlowDefinition, FlowStepRuntime, FlowType, StepOutcome } from '../flows/flow.types';
import {
  PaystackBeneficiaryState,
  assertBeneficiaryTransition,
  isPaystackBeneficiaryState,
} from '../flows/paystack-beneficiary/paystack-beneficiary-transitions';
import {
  Observed,
  PaystackRecipient,
  PaystackTransferCallFailedError,
  PaystackTransferRefusal,
  PaystackTransfersGateway,
  TransferCallFailureKind,
} from '../payments/paystack/transfers/paystack-transfers.port';
import { ProtectedEvidenceService } from '../protection/protected-evidence.service';
import { ProtectionService } from '../protection/protection.service';
import { BankDirectoryService } from './bank-directory.service';
import { RECIPIENT_TYPE, WITHDRAWAL_CURRENCY, WithdrawalTrail, beneficiaryContext } from './withdrawal-records';
import { WithdrawalReviewReason, openReview } from './withdrawal-reviews';

interface BeneficiaryRecord {
  id: string;
  user_id: string;
  bank_code: string;
  sealing_key_id: string;
  account_number_sealed: Buffer;
  resolved_account_name_sealed: Buffer | null;
}

const REVIEW_RETRY_SECONDS = 3600;
const RECIPIENT_SCAN_PAGES = 20;

/**
 * Prepares a withdrawal destination (WITHDRAWAL_PLAN.md §E.1): REQUESTED → RESOLVED (Paystack resolves the exact bank +
 * account; the name is Paystack's) → CREATING (the recipient payload frozen BEFORE any write) → READY (recipient created
 * or recovered, then checked against the exact identity). Every provider answer is kept as sealed evidence. A lost
 * create answer is recovered by scanning recipients for the exact identity — never by trusting a code or a name alone.
 * Only a definitive "could not resolve" fails it; anything ambiguous is a review, retried, never a guess.
 */
@Injectable()
export class BeneficiaryFlow implements FlowDefinition, OnModuleInit {
  readonly flowType = FlowType.PAYSTACK_BENEFICIARY;
  private readonly logger = new Logger(BeneficiaryFlow.name);

  constructor(
    private readonly runner: FlowRunner,
    private readonly unitOfWork: UnitOfWork,
    private readonly gateway: PaystackTransfersGateway,
    private readonly protection: ProtectionService,
    private readonly evidence: ProtectedEvidenceService,
    private readonly banks: BankDirectoryService,
    private readonly trail: WithdrawalTrail,
  ) {}

  onModuleInit(): void {
    this.runner.register(this);
  }

  isHintSatisfied(): boolean {
    return true;
  }

  async step(flow: ClaimedFlow, runtime: FlowStepRuntime): Promise<StepOutcome> {
    const state = flow.state;
    if (!isPaystackBeneficiaryState(state)) throw new InvariantViolationError(`Unknown beneficiary state ${state}.`, { flowId: flow.id });
    switch (state) {
      case PaystackBeneficiaryState.REQUESTED:
        return this.resolve(flow, runtime, await this.load(flow));
      case PaystackBeneficiaryState.RESOLVED:
        return this.freeze(flow, runtime);
      case PaystackBeneficiaryState.CREATING:
        return this.bindRecipient(flow, runtime, await this.load(flow));
      case PaystackBeneficiaryState.READY:
      case PaystackBeneficiaryState.FAILED:
        return { kind: 'IDLE', state };
    }
  }

  // ── REQUESTED ──

  private async resolve(flow: ClaimedFlow, runtime: FlowStepRuntime, record: BeneficiaryRecord): Promise<StepOutcome> {
    const accountNumber = await this.accountNumberOf(record);
    const state = PaystackBeneficiaryState.REQUESTED;
    let resolved;
    try {
      resolved = await this.gateway.resolveAccount(accountNumber, record.bank_code, { flowId: flow.id });
    } catch (error) {
      if (error instanceof PaystackTransferCallFailedError && error.refusal === PaystackTransferRefusal.ACCOUNT_NOT_RESOLVED) {
        return this.fail(flow, runtime, state, 'ACCOUNT_NOT_RESOLVED', error);
      }
      return this.reviewOrRethrow(flow, runtime, state, error);
    }
    await runtime.checkpoint(FlowCheckpoint.AFTER_EXTERNAL_CALL);
    const { value } = resolved;
    if (value.accountNumber !== accountNumber || value.accountName === null) {
      return this.review(flow, runtime, state, WithdrawalReviewReason.PROVIDER_RESPONSE_UNRESOLVED, resolved, 'resolution without a matching number and a name');
    }
    assertBeneficiaryTransition(state, PaystackBeneficiaryState.RESOLVED);
    await runtime.commit(state, { to: PaystackBeneficiaryState.RESOLVED }, async (manager) => {
      const stored = await this.store('bank.resolve', resolved);
      const name = await this.protection.sealForUser(record.user_id, value.accountName as string, beneficiaryContext(record.id, record.user_id, 'resolved_account_name_sealed'));
      this.assertSameKey(record, name.keyId);
      await manager.query(
        `UPDATE withdrawal_beneficiaries SET resolved_account_name_sealed = $2, resolution_evidence_id = $3, resolved_at = now() WHERE id = $1`,
        [record.id, name.sealed, stored],
      );
      await this.trail.changed('BENEFICIARY', flow.id, flow.userId, state, PaystackBeneficiaryState.RESOLVED);
    });
    return { kind: 'TRANSITIONED', from: state, to: PaystackBeneficiaryState.RESOLVED };
  }

  // ── RESOLVED ── (the recipient payload is frozen by the record itself; this marks "may have been created" first)

  private async freeze(flow: ClaimedFlow, runtime: FlowStepRuntime): Promise<StepOutcome> {
    const from = PaystackBeneficiaryState.RESOLVED;
    assertBeneficiaryTransition(from, PaystackBeneficiaryState.CREATING);
    await runtime.commit(from, { to: PaystackBeneficiaryState.CREATING }, async () => {
      await this.trail.changed('BENEFICIARY', flow.id, flow.userId, from, PaystackBeneficiaryState.CREATING);
    });
    return { kind: 'TRANSITIONED', from, to: PaystackBeneficiaryState.CREATING };
  }

  // ── CREATING ──

  private async bindRecipient(flow: ClaimedFlow, runtime: FlowStepRuntime, record: BeneficiaryRecord): Promise<StepOutcome> {
    const state = PaystackBeneficiaryState.CREATING;
    const accountNumber = await this.accountNumberOf(record);
    const matches = (recipient: PaystackRecipient) =>
      recipient.details.bankCode === record.bank_code &&
      recipient.details.accountNumber === accountNumber &&
      recipient.type === RECIPIENT_TYPE &&
      recipient.currency === WITHDRAWAL_CURRENCY;

    let bound: Observed<PaystackRecipient | null>;
    try {
      // Recovery first: a create whose answer was lost left a recipient behind. Exact identity only.
      const found: PaystackRecipient[] = [];
      let page: string | undefined;
      for (let index = 0; index < RECIPIENT_SCAN_PAGES; index += 1) {
        const { value } = await this.gateway.listRecipients({ page }, { flowId: flow.id });
        found.push(...value.items.filter(matches));
        if (!value.nextCursor) break;
        page = value.nextCursor;
      }
      const usable = found.filter((recipient) => recipient.active && !recipient.isDeleted);
      if (usable.length > 1 || (found.length > 0 && usable.length === 0)) {
        return this.reviewOnly(flow, runtime, state, WithdrawalReviewReason.RECIPIENT_IDENTITY_CONFLICT, 'several (or only inactive) recipients for this exact account');
      }
      if (usable.length === 1) {
        bound = await this.gateway.fetchRecipient(usable[0].recipientCode, { flowId: flow.id });
      } else {
        const name = await this.nameOf(record);
        bound = await this.gateway.createRecipient({ name, accountNumber, bankCode: record.bank_code, currency: WITHDRAWAL_CURRENCY }, { flowId: flow.id });
      }
    } catch (error) {
      if (error instanceof PaystackTransferCallFailedError && error.refusal === PaystackTransferRefusal.ACCOUNT_NOT_RESOLVED) {
        return this.fail(flow, runtime, state, 'ACCOUNT_NOT_RESOLVED', error);
      }
      return this.reviewOrRethrow(flow, runtime, state, error);
    }
    await runtime.checkpoint(FlowCheckpoint.AFTER_EXTERNAL_CALL);
    const recipient = bound.value;
    if (!recipient || !matches(recipient) || !recipient.active || recipient.isDeleted) {
      return this.review(flow, runtime, state, WithdrawalReviewReason.RECIPIENT_IDENTITY_CONFLICT, bound, 'the recipient does not match the exact identity');
    }
    const bankName = recipient.details.bankName ?? this.banks.cachedName(record.bank_code);
    if (!bankName) {
      return this.review(flow, runtime, state, WithdrawalReviewReason.PROVIDER_RESPONSE_UNRESOLVED, bound, 'no bank name for the recipient');
    }
    assertBeneficiaryTransition(state, PaystackBeneficiaryState.READY);
    await runtime.commit(state, { to: PaystackBeneficiaryState.READY, complete: true }, async (manager) => {
      const stored = await this.store(bound.exchange.operation, bound);
      const code = await this.protection.sealForUser(record.user_id, recipient.recipientCode, beneficiaryContext(record.id, record.user_id, 'provider_recipient_code_sealed'));
      const id = await this.protection.sealForUser(record.user_id, recipient.recipientId, beneficiaryContext(record.id, record.user_id, 'provider_recipient_id_sealed'));
      this.assertSameKey(record, code.keyId);
      await manager.query(
        `UPDATE withdrawal_beneficiaries
            SET provider_recipient_code_sealed = $2, provider_recipient_id_sealed = $3, recipient_evidence_id = $4,
                recipient_bound_at = now(), bank_name = $5
          WHERE id = $1`,
        [record.id, code.sealed, id.sealed, stored, bankName],
      );
      await this.trail.changed('BENEFICIARY', flow.id, flow.userId, state, PaystackBeneficiaryState.READY);
    });
    return { kind: 'TRANSITIONED', from: state, to: PaystackBeneficiaryState.READY };
  }

  // ── shared ──

  private async load(flow: ClaimedFlow): Promise<BeneficiaryRecord> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT id, user_id, bank_code, sealing_key_id, account_number_sealed, resolved_account_name_sealed
         FROM withdrawal_beneficiaries WHERE flow_id = $1`,
      [flow.id],
    )) as BeneficiaryRecord[];
    if (!row) throw new InvariantViolationError('A beneficiary flow has no beneficiary.', { flowId: flow.id });
    return row;
  }

  private async accountNumberOf(record: BeneficiaryRecord): Promise<string> {
    const plain = await this.protection.open(
      { keyId: record.sealing_key_id, sealed: record.account_number_sealed },
      beneficiaryContext(record.id, record.user_id, 'account_number_sealed'),
    );
    return plain.toString('utf8');
  }

  private async nameOf(record: BeneficiaryRecord): Promise<string> {
    if (!record.resolved_account_name_sealed) throw new InvariantViolationError('A CREATING beneficiary has no resolved name.', { beneficiaryId: record.id });
    const plain = await this.protection.open(
      { keyId: record.sealing_key_id, sealed: record.resolved_account_name_sealed },
      beneficiaryContext(record.id, record.user_id, 'resolved_account_name_sealed'),
    );
    return plain.toString('utf8');
  }

  /** One data key per row: every sealed column of a beneficiary names `sealing_key_id` (the owner's key never changes). */
  private assertSameKey(record: BeneficiaryRecord, keyId: string): void {
    if (keyId !== record.sealing_key_id) {
      throw new InvariantViolationError('A beneficiary must be sealed under one data key.', { beneficiaryId: record.id });
    }
  }

  private async store(operation: string, observed: { exchange: Observed<unknown>['exchange'] }): Promise<string> {
    if (!observed.exchange.rawResponse) throw new InvariantViolationError('A provider answer without bytes cannot be evidence.', { operation });
    const stored = await this.evidence.store({
      provider: 'paystack',
      operation,
      content: observed.exchange.rawResponse,
      providerCallId: observed.exchange.providerCallId,
    });
    return stored.evidenceId;
  }

  private async fail(flow: ClaimedFlow, runtime: FlowStepRuntime, from: PaystackBeneficiaryState, failureCode: string, error: PaystackTransferCallFailedError): Promise<StepOutcome> {
    assertBeneficiaryTransition(from, PaystackBeneficiaryState.FAILED);
    await runtime.commit(from, { to: PaystackBeneficiaryState.FAILED, complete: true, note: failureCode }, async (manager) => {
      if (error.exchange.rawResponse) await this.store(error.exchange.operation, error);
      await manager.query(`UPDATE withdrawal_beneficiaries SET failure_code = $2 WHERE flow_id = $1`, [flow.id, failureCode]);
      await this.trail.changed('BENEFICIARY', flow.id, flow.userId, from, PaystackBeneficiaryState.FAILED, { failureCode });
    });
    return { kind: 'TRANSITIONED', from, to: PaystackBeneficiaryState.FAILED };
  }

  /** Configuration and unreadable answers are reviews (kept, retried hourly); transient ones retry with backoff. */
  private async reviewOrRethrow(flow: ClaimedFlow, runtime: FlowStepRuntime, state: PaystackBeneficiaryState, error: unknown): Promise<StepOutcome> {
    if (error instanceof PaystackTransferCallFailedError && error.kind !== TransferCallFailureKind.TRANSIENT) {
      const reason = error.kind === TransferCallFailureKind.CONFIGURATION ? WithdrawalReviewReason.PROVIDER_APPROVAL_REQUIRED : WithdrawalReviewReason.PROVIDER_RESPONSE_UNRESOLVED;
      return this.review(flow, runtime, state, reason, error, `${error.kind}${error.refusal ? ` (${error.refusal})` : ''}`);
    }
    throw error;
  }

  private async review(
    flow: ClaimedFlow,
    runtime: FlowStepRuntime,
    state: PaystackBeneficiaryState,
    reason: WithdrawalReviewReason,
    observed: { exchange: Observed<unknown>['exchange'] },
    note: string,
  ): Promise<StepOutcome> {
    this.logger.warn({ flowId: flow.id, reason, note }, 'Beneficiary preparation needs review');
    await runtime.commit(state, { retryInSeconds: REVIEW_RETRY_SECONDS, note: `review: ${note}` }, async (manager) => {
      const evidenceId = observed.exchange.rawResponse ? await this.store(observed.exchange.operation, observed) : undefined;
      await openReview(manager, { table: 'withdrawal_beneficiaries', flowId: flow.id }, { reason, evidenceId });
    });
    return { kind: 'PROGRESSED', state };
  }

  private async reviewOnly(flow: ClaimedFlow, runtime: FlowStepRuntime, state: PaystackBeneficiaryState, reason: WithdrawalReviewReason, note: string): Promise<StepOutcome> {
    await runtime.commit(state, { retryInSeconds: REVIEW_RETRY_SECONDS, note: `review: ${note}` }, async (manager) => {
      await openReview(manager, { table: 'withdrawal_beneficiaries', flowId: flow.id }, { reason });
    });
    return { kind: 'PROGRESSED', state };
  }
}
