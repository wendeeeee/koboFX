import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { InvariantViolationError } from '../../../common/errors';
import { AuditAction, AuditLogService, AuditSubjectType } from '../../audit/audit-log.service';
import { LedgerService } from '../../ledger/ledger.service';
import { EntryDirection, PostingAuthorization, TransactionType } from '../../ledger/ledger.types';
import { PaymentProvider, ProviderPayment, ProviderPaymentStatus } from '../../payments/payment-provider.port';
import { UserRepository } from '../../users/user.repository';
import { UserStatus } from '../../users/user.types';
import { FlowRunner } from '../flow-runner';
import { ClaimedFlow, FlowCheckpoint, FlowDefinition, FlowStepRuntime, FlowType, StepOutcome } from '../flow.types';
import { FundingPayment, FundingPaymentRepository, FundingPaymentUpdate } from './funding-payment.repository';
import { FundingState, assertTransition, isFundingHintSatisfied, isFundingState } from './funding-transitions';
import { ProviderPaymentMismatchError } from './funding.errors';

/** PSP statuses after which the money never moves: the flow fails, nothing is posted. */
const NOT_CAPTURED_FINAL = new Set([
  ProviderPaymentStatus.DECLINED,
  ProviderPaymentStatus.EXPIRED,
  ProviderPaymentStatus.VOIDED,
  ProviderPaymentStatus.CAPTURE_FAILED,
]);

/** Polling interval while the PSP finishes a capture; a webhook usually arrives first. */
const CAPTURE_PENDING_RETRY_SECONDS = 5;
/** A partial chargeback waits for a human (Phase 10 CORRECTION); re-check it rarely. */
const PARKED_RETRY_SECONDS = 3600;

export const FUNDING_INITIATED_BY = 'job:funding-flow';

/**
 * The funding flow (design §7.5; handbook Appendix B, Flow 2), one step per state:
 *
 * - INITIATED — find the payment at the PSP by our reference (the flow id); only if it
 *   does not exist, authorize with `Idempotency-Key: authorize:{flowId}`. Authorized →
 *   AUTHORIZED; declined/expired/voided → FAILED. **Nothing is credited.**
 * - AUTHORIZED — read the payment. Captured (per the PSP's API, never a webhook) →
 *   CAPTURED; failed → FAILED; still authorized → request capture with
 *   `Idempotency-Key: capture:{flowId}` (or void it, for a suspended user); pending → wait.
 * - CAPTURED — database only: post DEBIT `PSP_RECEIVABLE` / CREDIT the user, gross, as
 *   `funding:{flowId}` (UNIQUE), in the same transaction as → POSTED.
 * - POSTED — (a webhook hint, or a chargeback seen before posting) read the payment; a
 *   full chargeback is a `REVERSAL` mirroring the funding posting → REVERSED. It may
 *   drive the balance negative, which is recorded, never clamped.
 *
 * Every step re-reads before it re-sends, commits through the fenced, state-guarded
 * `runtime.commit`, and may be re-run at any point after a crash.
 */
@Injectable()
export class FundingFlow implements FlowDefinition, OnModuleInit {
  readonly flowType = FlowType.FUNDING;
  private readonly logger = new Logger(FundingFlow.name);

  constructor(
    private readonly runner: FlowRunner,
    private readonly payments: FundingPaymentRepository,
    private readonly provider: PaymentProvider,
    private readonly ledger: LedgerService,
    private readonly audit: AuditLogService,
    private readonly users: UserRepository,
  ) {}

  onModuleInit(): void {
    this.runner.register(this);
  }

  isHintSatisfied(state: string, eventType: string): boolean {
    return isFundingState(state) && isFundingHintSatisfied(state, eventType);
  }

  async step(flow: ClaimedFlow, runtime: FlowStepRuntime): Promise<StepOutcome> {
    const state = flow.state;
    if (!isFundingState(state)) throw new InvariantViolationError(`Unknown funding state ${state}.`, { flowId: flow.id });
    const payment = await this.payments.findByFlowId(flow.id);
    if (!payment) throw new InvariantViolationError('A funding flow has no funding payment.', { flowId: flow.id });
    switch (state) {
      case FundingState.INITIATED:
        return this.authorize(flow, payment, runtime);
      case FundingState.AUTHORIZED:
        return this.confirmCapture(flow, payment, runtime);
      case FundingState.CAPTURED:
        return this.postFunding(flow, payment, runtime);
      case FundingState.POSTED:
      case FundingState.SETTLED:
        // A chargeback usually lands AFTER settlement (Phase 5 decision 2): SETTLED → REVERSED.
        return this.checkForChargeback(flow, payment, runtime, state);
      case FundingState.FAILED:
      case FundingState.REVERSED:
        return { kind: 'IDLE', state };
    }
  }

  private async authorize(flow: ClaimedFlow, payment: FundingPayment, runtime: FlowStepRuntime): Promise<StepOutcome> {
    if (await this.isSuspended(flow.userId)) {
      return this.fail(flow, runtime, FundingState.INITIATED, 'USER_SUSPENDED', {});
    }
    const context = { flowId: flow.id };
    let result = payment.providerPaymentId
      ? await this.provider.getPayment(payment.providerPaymentId, context)
      : await this.provider.findPaymentByReference(flow.id, context);
    if (!result) {
      if (!payment.paymentMethodToken) {
        throw new InvariantViolationError('No payment at the PSP and no payment method token to authorize with.', {
          flowId: flow.id,
        });
      }
      result = await this.provider.authorize(
        {
          reference: flow.id,
          amount: payment.amount,
          paymentMethodToken: payment.paymentMethodToken,
          idempotencyKey: `authorize:${flow.id}`,
        },
        context,
      );
    }
    this.assertMatches(flow, payment, result);
    await runtime.checkpoint(FlowCheckpoint.AFTER_EXTERNAL_CALL);

    const observed = { providerPaymentId: result.paymentId, providerStatus: result.status, clearPaymentMethodToken: true };
    if (result.status === ProviderPaymentStatus.DECLINED || result.status === ProviderPaymentStatus.EXPIRED || result.status === ProviderPaymentStatus.VOIDED) {
      return this.fail(flow, runtime, FundingState.INITIATED, failureCodeOf(result), observed);
    }
    return this.transition(flow, runtime, FundingState.INITIATED, FundingState.AUTHORIZED, { ...observed, authorized: true });
  }

  private async confirmCapture(flow: ClaimedFlow, payment: FundingPayment, runtime: FlowStepRuntime): Promise<StepOutcome> {
    const paymentId = requirePaymentId(flow, payment);
    const context = { flowId: flow.id };
    let result = await this.provider.getPayment(paymentId, context);
    this.assertMatches(flow, payment, result);

    if (result.status === ProviderPaymentStatus.AUTHORIZED) {
      if (!payment.captureRequestedAt && (await this.isSuspended(flow.userId))) {
        result = await this.provider.void(paymentId, `void:${flow.id}`, context);
        this.assertMatches(flow, payment, result);
        await runtime.checkpoint(FlowCheckpoint.AFTER_EXTERNAL_CALL);
        if (result.status === ProviderPaymentStatus.VOIDED) {
          return this.fail(flow, runtime, FundingState.AUTHORIZED, 'USER_SUSPENDED', { providerStatus: result.status });
        }
        return this.progress(flow, runtime, FundingState.AUTHORIZED, { providerStatus: result.status }, 0);
      }
      result = await this.provider.capture(paymentId, payment.amount, `capture:${flow.id}`, context);
      this.assertMatches(flow, payment, result);
    }
    await runtime.checkpoint(FlowCheckpoint.AFTER_EXTERNAL_CALL);

    if (result.status === ProviderPaymentStatus.CAPTURED || result.status === ProviderPaymentStatus.CHARGED_BACK) {
      if (!result.capturedAt) {
        throw new ProviderPaymentMismatchError('The PSP reports a captured payment without a capture time.', { flowId: flow.id });
      }
      return this.transition(flow, runtime, FundingState.AUTHORIZED, FundingState.CAPTURED, {
        providerStatus: result.status,
        captureRequested: true,
        capturedAt: result.capturedAt,
      });
    }
    if (NOT_CAPTURED_FINAL.has(result.status)) {
      return this.fail(flow, runtime, FundingState.AUTHORIZED, failureCodeOf(result), { providerStatus: result.status });
    }
    // Capture requested and pending at the PSP (or the PSP's read still lags our request).
    if (payment.captureRequestedAt && payment.providerStatus === result.status) {
      return { kind: 'WAITING', state: FundingState.AUTHORIZED, reason: `PSP status ${result.status}; capture pending`, retryInSeconds: CAPTURE_PENDING_RETRY_SECONDS };
    }
    return this.progress(
      flow,
      runtime,
      FundingState.AUTHORIZED,
      { providerStatus: result.status, captureRequested: true },
      CAPTURE_PENDING_RETRY_SECONDS,
    );
  }

  private async postFunding(flow: ClaimedFlow, payment: FundingPayment, runtime: FlowStepRuntime): Promise<StepOutcome> {
    const paymentId = requirePaymentId(flow, payment);
    if (!payment.capturedAt) throw new InvariantViolationError('A captured funding has no capture time.', { flowId: flow.id });
    const capturedAt = payment.capturedAt;
    // A chargeback seen before posting keeps the flow open, so the resumer reverses it next.
    const complete = payment.providerStatus !== ProviderPaymentStatus.CHARGED_BACK;
    await runtime.commit(FundingState.CAPTURED, { to: FundingState.POSTED, complete }, async (manager) => {
      const posted = await this.ledger.post({
        transaction: {
          type: TransactionType.FUNDING,
          authorization: PostingAuthorization.SYSTEM_DRIVEN,
          valueTime: capturedAt,
          initiatedBy: `user:${flow.userId}`,
          reference: `funding:${flow.id}`,
          userId: flow.userId,
          reasonCode: 'CARD_DEPOSIT',
          externalReference: paymentId,
          metadata: { flowId: flow.id, provider: payment.provider },
        },
        entries: [
          { account: { systemAccount: 'PSP_RECEIVABLE' }, direction: EntryDirection.DEBIT, amount: payment.amount },
          { account: { accountId: payment.accountId }, direction: EntryDirection.CREDIT, amount: payment.amount },
        ],
      });
      await this.payments.update(manager, flow.id, { fundingTransactionId: posted.transactionId });
      await this.recordTransition(flow, FundingState.CAPTURED, FundingState.POSTED, { transactionId: posted.transactionId });
    });
    return { kind: 'TRANSITIONED', from: FundingState.CAPTURED, to: FundingState.POSTED };
  }

  private async checkForChargeback(
    flow: ClaimedFlow,
    payment: FundingPayment,
    runtime: FlowStepRuntime,
    state: FundingState.POSTED | FundingState.SETTLED,
  ): Promise<StepOutcome> {
    const paymentId = requirePaymentId(flow, payment);
    const fundingTransactionId = payment.fundingTransactionId;
    if (!fundingTransactionId) throw new InvariantViolationError('A posted funding has no transaction.', { flowId: flow.id });
    const result = await this.provider.getPayment(paymentId, { flowId: flow.id });
    this.assertMatches(flow, payment, result);
    await runtime.checkpoint(FlowCheckpoint.AFTER_EXTERNAL_CALL);

    const chargeback = result.status === ProviderPaymentStatus.CHARGED_BACK ? result.chargeback : null;
    // Already booked — by an approved partial-chargeback CORRECTION (Phase 10): nothing left for the flow to do.
    // (A full chargeback moves the flow to REVERSED and never gets here again.)
    if (chargeback && payment.chargebackTransactionId) return { kind: 'IDLE', state };
    if (!chargeback) {
      if (flow.completedAt) return { kind: 'IDLE', state };
      return this.progress(flow, runtime, state, { providerStatus: result.status }, 0, true);
    }
    if (!chargeback.amount.equals(payment.amount)) {
      this.logger.error(
        { flowId: flow.id, chargebackMinor: chargeback.amount.toMinorString(), fundedMinor: payment.amount.toMinorString() },
        'Partial chargeback: parked for an approved correction',
      );
      return {
        kind: 'WAITING',
        state,
        reason: `PARTIAL_CHARGEBACK_UNSUPPORTED: ${chargeback.amount.toMinorString()} of ${payment.amount.toMinorString()}`,
        retryInSeconds: PARKED_RETRY_SECONDS,
      };
    }
    assertTransition(state, FundingState.REVERSED);
    await runtime.commit(state, { to: FundingState.REVERSED, complete: true }, async (manager) => {
      const reversal = await this.ledger.buildReversalRequest(fundingTransactionId, {
        valueTime: chargeback.createdAt,
        initiatedBy: FUNDING_INITIATED_BY,
        reasonCode: 'CHARGEBACK',
      });
      const posted = await this.ledger.post({
        transaction: {
          ...reversal.transaction,
          reference: `chargeback:${flow.id}`,
          externalReference: chargeback.chargebackId,
          metadata: { flowId: flow.id, provider: payment.provider, providerPaymentId: paymentId },
        },
        entries: reversal.entries,
      });
      await this.payments.update(manager, flow.id, {
        chargebackTransactionId: posted.transactionId,
        providerStatus: result.status,
      });
      await this.recordTransition(flow, state, FundingState.REVERSED, { transactionId: posted.transactionId });
    });
    return { kind: 'TRANSITIONED', from: state, to: FundingState.REVERSED };
  }

  private async transition(
    flow: ClaimedFlow,
    runtime: FlowStepRuntime,
    from: FundingState,
    to: FundingState,
    update: FundingPaymentUpdate,
  ): Promise<StepOutcome> {
    assertTransition(from, to);
    await runtime.commit(from, { to }, async (manager) => {
      await this.payments.update(manager, flow.id, update);
      await this.recordTransition(flow, from, to, {});
    });
    return { kind: 'TRANSITIONED', from, to };
  }

  private async fail(
    flow: ClaimedFlow,
    runtime: FlowStepRuntime,
    from: FundingState,
    failureCode: string,
    update: FundingPaymentUpdate,
  ): Promise<StepOutcome> {
    assertTransition(from, FundingState.FAILED);
    await runtime.commit(from, { to: FundingState.FAILED, complete: true }, async (manager) => {
      await this.payments.update(manager, flow.id, { ...update, failureCode, clearPaymentMethodToken: true });
      await this.recordTransition(flow, from, FundingState.FAILED, { failureCode });
    });
    return { kind: 'TRANSITIONED', from, to: FundingState.FAILED };
  }

  private async progress(
    flow: ClaimedFlow,
    runtime: FlowStepRuntime,
    state: FundingState,
    update: FundingPaymentUpdate,
    retryInSeconds: number,
    complete = false,
  ): Promise<StepOutcome> {
    await runtime.commit(state, { retryInSeconds, complete }, (manager: EntityManager) =>
      this.payments.update(manager, flow.id, update),
    );
    return { kind: 'PROGRESSED', state };
  }

  private recordTransition(
    flow: ClaimedFlow,
    from: FundingState,
    to: FundingState,
    after: { failureCode?: string; transactionId?: string },
  ): Promise<void> {
    return this.audit.record({
      actor: { type: 'SYSTEM' },
      action: AuditAction.FUNDING_STATE_CHANGED,
      subject: { type: AuditSubjectType.FLOW, id: flow.id },
      before: { flowState: from },
      after: { flowState: to, ...after },
      reason: `funding flow ${from} → ${to}`,
    });
  }

  private async isSuspended(userId: string): Promise<boolean> {
    const user = await this.users.findProfile(userId);
    return user?.status === UserStatus.SUSPENDED;
  }

  /** The PSP's payment must be the one we asked for — same reference, id, amount and currency. */
  private assertMatches(flow: ClaimedFlow, payment: FundingPayment, result: ProviderPayment): void {
    const problems: string[] = [];
    if (result.reference !== flow.id) problems.push('reference');
    if (payment.providerPaymentId && result.paymentId !== payment.providerPaymentId) problems.push('payment id');
    if (!result.amount.isSameCurrency(payment.amount) || !result.amount.equals(payment.amount)) problems.push('amount');
    if (problems.length > 0) {
      throw new ProviderPaymentMismatchError(`The PSP's payment does not match the funding (${problems.join(', ')}).`, {
        flowId: flow.id,
        mismatched: problems,
      });
    }
  }
}

function requirePaymentId(flow: ClaimedFlow, payment: FundingPayment): string {
  if (!payment.providerPaymentId) {
    throw new InvariantViolationError('An authorized funding has no PSP payment id.', { flowId: flow.id });
  }
  return payment.providerPaymentId;
}

/** `DECLINED:insufficient_funds`, or the status itself. Never card data. */
function failureCodeOf(result: ProviderPayment): string {
  return result.declineCode ? `${result.status}:${result.declineCode}` : result.status;
}
