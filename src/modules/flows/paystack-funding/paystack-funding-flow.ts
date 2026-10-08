import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import { InvariantViolationError } from '../../../common/errors';
import { exponentialBackoffSeconds } from '../../../common/polling/backoff';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { AuditAction, AuditLogService, AuditSubjectType } from '../../audit/audit-log.service';
import { LedgerService } from '../../ledger/ledger.service';
import { EntryDirection, PostingAuthorization, TransactionType } from '../../ledger/ledger.types';
import { OutboxService } from '../../outbox/outbox.service';
import { FundingPostedPayload, OutboxEventType } from '../../outbox/outbox.types';
import { ProviderUnavailableError } from '../../payments/payment.errors';
import { PaystackDispute, PaystackGateway, PaystackTransaction } from '../../payments/paystack/paystack-gateway.port';
import { PAYSTACK_STATUS_MEANING, PaystackStatusMeaning } from '../../payments/paystack/paystack-status';
import { PaystackDuplicateReferenceError } from '../../payments/paystack/paystack.errors';
import { UserRepository } from '../../users/user.repository';
import { UserStatus } from '../../users/user.types';
import { FlowRunner } from '../flow-runner';
import { ClaimedFlow, FlowCheckpoint, FlowDefinition, FlowStepRuntime, FlowType, StepOutcome } from '../flow.types';
import { FundingPayment, FundingPaymentRepository, FundingPaymentUpdate } from '../funding/funding-payment.repository';
import { ProviderPaymentMismatchError } from '../funding/funding.errors';
import {
  PaystackFundingState,
  assertPaystackTransition,
  isPaystackFundingState,
  isPaystackHintSatisfied,
} from './paystack-funding-transitions';

export const PAYSTACK_RECEIVABLE = 'PAYSTACK_RECEIVABLE';
export const PAYSTACK_FUNDING_INITIATED_BY = 'job:paystack-funding-flow';

const POLL_BASE_SECONDS = 5;
const POLL_MAXIMUM_SECONDS = 60;

const IN_FLIGHT_AFTER_WINDOW_SECONDS = 300;
const PARKED_RETRY_SECONDS = 3600;
const LOST_DISPUTE_RESOLUTION = 'merchant-accepted';


export function creditProblems(transaction: PaystackTransaction, payment: FundingPayment, flowId: string): string[] {
  const problems: string[] = [];
  if (PAYSTACK_STATUS_MEANING[transaction.status] !== PaystackStatusMeaning.PAID) problems.push('status');
  if (transaction.reference !== flowId) problems.push('reference');
  if (transaction.amount.currency !== payment.amount.currency) problems.push('currency');
  if (transaction.amount.amountMinor !== payment.amount.amountMinor) problems.push('amount');
  if (!transaction.paidAt) problems.push('paid_at');
  return problems;
}


@Injectable()
export class PaystackFundingFlow implements FlowDefinition, OnModuleInit {
  readonly flowType = FlowType.PAYSTACK_FUNDING;
  private readonly logger = new Logger(PaystackFundingFlow.name);

  constructor(
    private readonly runner: FlowRunner,
    private readonly payments: FundingPaymentRepository,
    private readonly paystack: PaystackGateway,
    private readonly ledger: LedgerService,
    private readonly audit: AuditLogService,
    private readonly outbox: OutboxService,
    private readonly users: UserRepository,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.runner.register(this);
  }

  isHintSatisfied(state: string, eventType: string): boolean {
    return isPaystackFundingState(state) && isPaystackHintSatisfied(state, eventType);
  }

  async step(flow: ClaimedFlow, runtime: FlowStepRuntime): Promise<StepOutcome> {
    const state = flow.state;
    if (!isPaystackFundingState(state)) throw new InvariantViolationError(`Unknown Paystack funding state ${state}.`, { flowId: flow.id });
    const payment = await this.payments.findByFlowId(flow.id);
    if (!payment) throw new InvariantViolationError('A Paystack funding flow has no funding payment.', { flowId: flow.id });
    if (payment.provider !== this.paystack.name) {
      throw new InvariantViolationError('A Paystack funding flow belongs to another provider.', { flowId: flow.id });
    }
    switch (state) {
      case PaystackFundingState.INITIATED:
        return this.initializeCheckout(flow, payment, runtime);
      case PaystackFundingState.CHECKOUT_READY:
        return this.confirmPayment(flow, payment, runtime);
      case PaystackFundingState.POSTED:
      case PaystackFundingState.SETTLED:
        return this.checkForLostDispute(flow, payment, runtime, state);
      case PaystackFundingState.FAILED:
      case PaystackFundingState.REVERSED:
      case PaystackFundingState.HELD:
        return { kind: 'IDLE', state };
    }
  }

  // ── INITIATED ──

  private async initializeCheckout(flow: ClaimedFlow, payment: FundingPayment, runtime: FlowStepRuntime): Promise<StepOutcome> {
    const context = { flowId: flow.id };
  
    let existing = await this.paystack.verify(flow.id, context);
    if (!existing) {
      const user = await this.users.findProfile(flow.userId);
      if (!user) throw new InvariantViolationError('A Paystack funding flow has no user.', { flowId: flow.id });
      if (user.status === UserStatus.SUSPENDED) {
        return this.fail(flow, runtime, PaystackFundingState.INITIATED, 'USER_SUSPENDED', {});
      }
      try {
        const checkout = await this.paystack.initialize(
          {
            reference: flow.id,
            amount: payment.amount,
            email: user.email,
            callbackUrl: this.config.paystack.callbackUrl,
            metadata: { flowId: flow.id },
          },
          context,
        );
        await runtime.checkpoint(FlowCheckpoint.AFTER_EXTERNAL_CALL);
        const expiresAt = new Date(this.clock.now().getTime() + this.config.paystack.checkoutWindowMinutes * 60_000);
        assertPaystackTransition(PaystackFundingState.INITIATED, PaystackFundingState.CHECKOUT_READY);
        await runtime.commit(PaystackFundingState.INITIATED, { to: PaystackFundingState.CHECKOUT_READY, retryInSeconds: POLL_BASE_SECONDS }, async (manager) => {
          await this.payments.recordCheckout(manager, flow.id, {
            authorizationUrl: checkout.authorizationUrl,
            accessCode: checkout.accessCode,
            expiresAt,
          });
          await this.recordTransition(flow, PaystackFundingState.INITIATED, PaystackFundingState.CHECKOUT_READY, {});
        });
        return { kind: 'TRANSITIONED', from: PaystackFundingState.INITIATED, to: PaystackFundingState.CHECKOUT_READY };
      } catch (error) {
        if (!(error instanceof PaystackDuplicateReferenceError)) throw error;
        existing = await this.paystack.verify(flow.id, context);
        if (!existing) {
          throw new ProviderUnavailableError('Paystack reports a duplicate reference that verify cannot see yet', 'verify');
        }
      }
    }
    await runtime.checkpoint(FlowCheckpoint.AFTER_EXTERNAL_CALL);

    if (existing.reference !== flow.id) {
      throw new ProviderPaymentMismatchError('Paystack answered verify with another reference.', { flowId: flow.id });
    }
    const meaning = PAYSTACK_STATUS_MEANING[existing.status];
    if (meaning === PaystackStatusMeaning.PAID) return this.settlePaid(flow, payment, runtime, PaystackFundingState.INITIATED, existing);
    if (meaning === PaystackStatusMeaning.IN_FLIGHT) {
      return { kind: 'WAITING', state: PaystackFundingState.INITIATED, reason: `Paystack status ${existing.status}`, retryInSeconds: IN_FLIGHT_AFTER_WINDOW_SECONDS };
    }
    return this.fail(flow, runtime, PaystackFundingState.INITIATED, 'CHECKOUT_UNRECOVERABLE', {
      providerPaymentId: existing.transactionId,
      providerStatus: existing.status,
    });
  }

  // ── CHECKOUT_READY ──

  private async confirmPayment(flow: ClaimedFlow, payment: FundingPayment, runtime: FlowStepRuntime): Promise<StepOutcome> {
    const checkout = payment.checkout;
    if (!checkout) throw new InvariantViolationError('A ready Paystack checkout has no checkout recorded.', { flowId: flow.id });
    const transaction = await this.paystack.verify(flow.id, { flowId: flow.id });
    await runtime.checkpoint(FlowCheckpoint.AFTER_EXTERNAL_CALL);
    const windowOver = this.clock.now().getTime() >= checkout.expiresAt.getTime();
    const state = PaystackFundingState.CHECKOUT_READY;

    if (!transaction) {
      if (windowOver) return this.fail(flow, runtime, state, 'CHECKOUT_EXPIRED:not_found', {});
      return this.waitForCustomer(flow, 'Paystack has no transaction for the reference yet');
    }
    if (transaction.reference !== flow.id) {
      throw new ProviderPaymentMismatchError('Paystack answered verify with another reference.', { flowId: flow.id });
    }
    switch (PAYSTACK_STATUS_MEANING[transaction.status]) {
      case PaystackStatusMeaning.PAID:
        return this.settlePaid(flow, payment, runtime, state, transaction);
      case PaystackStatusMeaning.REVERSED:
        return this.fail(flow, runtime, state, 'PAYSTACK_REVERSED', { providerPaymentId: transaction.transactionId, providerStatus: transaction.status });
      case PaystackStatusMeaning.UNPAID:
        if (windowOver) {
          return this.fail(flow, runtime, state, `CHECKOUT_EXPIRED:${transaction.status}`, {
            providerPaymentId: transaction.transactionId,
            providerStatus: transaction.status,
          });
        }
        return this.waitForCustomer(flow, `Paystack status ${transaction.status}`);
      case PaystackStatusMeaning.IN_FLIGHT:
        // Money may be moving: never failed on time alone (Phase 5 decision 8).
        if (windowOver) {
          return { kind: 'WAITING', state, reason: `Paystack status ${transaction.status} after the checkout window`, retryInSeconds: IN_FLIGHT_AFTER_WINDOW_SECONDS };
        }
        return this.waitForCustomer(flow, `Paystack status ${transaction.status}`);
    }
  }

  private waitForCustomer(flow: ClaimedFlow, reason: string): StepOutcome {
    return {
      kind: 'WAITING',
      state: PaystackFundingState.CHECKOUT_READY,
      reason,
      retryInSeconds: exponentialBackoffSeconds(flow.attempts, POLL_BASE_SECONDS, POLL_MAXIMUM_SECONDS),
    };
  }

  /** Paid at Paystack. only credit when every field matches ours, else HOLD */
  private async settlePaid(
    flow: ClaimedFlow,
    payment: FundingPayment,
    runtime: FlowStepRuntime,
    from: PaystackFundingState.INITIATED | PaystackFundingState.CHECKOUT_READY,
    transaction: PaystackTransaction,
  ): Promise<StepOutcome> {
    const problems = creditProblems(transaction, payment, flow.id);
    if (problems.length > 0) return this.hold(flow, runtime, from, transaction, problems);
    const paidAt = transaction.paidAt as Date;
    assertPaystackTransition(from, PaystackFundingState.POSTED);
    await runtime.commit(from, { to: PaystackFundingState.POSTED, complete: true }, async (manager) => {
      const recheck = creditProblems(transaction, payment, flow.id);
      if (recheck.length > 0) {
        throw new ProviderPaymentMismatchError('A Paystack credit no longer matches the funding.', { flowId: flow.id, mismatched: recheck });
      }
      const posted = await this.ledger.post({
        transaction: {
          type: TransactionType.FUNDING,
          authorization: PostingAuthorization.SYSTEM_DRIVEN,
          valueTime: paidAt,
          initiatedBy: `user:${flow.userId}`,
          reference: `funding:${flow.id}`,
          userId: flow.userId,
          reasonCode: 'CARD_DEPOSIT',
          externalReference: transaction.transactionId,
          metadata: { flowId: flow.id, provider: payment.provider },
        },
        entries: [
          { account: { systemAccount: PAYSTACK_RECEIVABLE }, direction: EntryDirection.DEBIT, amount: payment.amount },
          { account: { accountId: payment.accountId }, direction: EntryDirection.CREDIT, amount: payment.amount },
        ],
      });
      await this.payments.update(manager, flow.id, {
        providerPaymentId: transaction.transactionId,
        providerStatus: transaction.status,
        capturedAt: paidAt,
        fundingTransactionId: posted.transactionId,
      });
      const event: FundingPostedPayload = { transactionId: posted.transactionId, userId: flow.userId, flowId: flow.id, provider: payment.provider };
      await this.outbox.enqueue(OutboxEventType.FUNDING_POSTED, posted.transactionId, event);
      await this.recordTransition(flow, from, PaystackFundingState.POSTED, { transactionId: posted.transactionId });
    });
    return { kind: 'TRANSITIONED', from, to: PaystackFundingState.POSTED };
  }

  private async hold(
    flow: ClaimedFlow,
    runtime: FlowStepRuntime,
    from: PaystackFundingState.INITIATED | PaystackFundingState.CHECKOUT_READY,
    transaction: PaystackTransaction,
    problems: string[],
  ): Promise<StepOutcome> {
    this.logger.error(
      {
        flowId: flow.id,
        mismatched: problems,
        paystackAmountMinor: transaction.amount.toMinorString(),
        paystackCurrency: transaction.amount.currency,
      },
      'Paystack says paid but not what we asked for: HELD, nothing credited',
    );
    assertPaystackTransition(from, PaystackFundingState.HELD);
    await runtime.commit(from, { to: PaystackFundingState.HELD, complete: true, note: `HELD: ${problems.join(', ')}` }, async (manager) => {
      await this.payments.update(manager, flow.id, {
        providerPaymentId: transaction.transactionId,
        providerStatus: transaction.status,
        failureCode: `HELD:${problems.join(',')}`,
      });
      await this.recordTransition(flow, from, PaystackFundingState.HELD, { failureCode: `HELD:${problems.join(',')}` });
    });
    return { kind: 'TRANSITIONED', from, to: PaystackFundingState.HELD };
  }

  // ── POSTED / SETTLED ──

  private async checkForLostDispute(
    flow: ClaimedFlow,
    payment: FundingPayment,
    runtime: FlowStepRuntime,
    state: PaystackFundingState.POSTED | PaystackFundingState.SETTLED,
  ): Promise<StepOutcome> {
    const transactionId = payment.providerPaymentId;
    const fundingTransactionId = payment.fundingTransactionId;
    if (!transactionId || !fundingTransactionId) {
      throw new InvariantViolationError('A posted Paystack funding has no transaction ids.', { flowId: flow.id });
    }
  
    if (payment.chargebackTransactionId) return { kind: 'IDLE', state };
    const lost = await this.findLostDispute(flow, payment, transactionId);
    await runtime.checkpoint(FlowCheckpoint.AFTER_EXTERNAL_CALL);
    if (!lost) return { kind: 'IDLE', state };
    if (!lost.refundAmount || !lost.refundAmount.equals(payment.amount)) {
      this.logger.error(
        { flowId: flow.id, disputeId: lost.disputeId, refundMinor: lost.refundAmount?.toMinorString() ?? null, fundedMinor: payment.amount.toMinorString() },
        'Partial (or unstated) Paystack dispute: parked for an approved correction',
      );
      return {
        kind: 'WAITING',
        state,
        reason: `PARTIAL_CHARGEBACK_UNSUPPORTED: ${lost.refundAmount?.toMinorString() ?? 'unstated'} of ${payment.amount.toMinorString()}`,
        retryInSeconds: PARKED_RETRY_SECONDS,
      };
    }
    assertPaystackTransition(state, PaystackFundingState.REVERSED);
    await runtime.commit(state, { to: PaystackFundingState.REVERSED, complete: true }, async (manager) => {
      const reversal = await this.ledger.buildReversalRequest(fundingTransactionId, {
        valueTime: lost.resolvedAt ?? lost.createdAt,
        initiatedBy: PAYSTACK_FUNDING_INITIATED_BY,
        reasonCode: 'CHARGEBACK',
      });
      const posted = await this.ledger.post({
        transaction: {
          ...reversal.transaction,
          reference: `chargeback:${flow.id}`,
          externalReference: lost.disputeId,
          metadata: { flowId: flow.id, provider: payment.provider, providerPaymentId: transactionId },
        },
        entries: reversal.entries,
      });
      await this.payments.update(manager, flow.id, { chargebackTransactionId: posted.transactionId });
      await this.recordTransition(flow, state, PaystackFundingState.REVERSED, { transactionId: posted.transactionId });
    });
    return { kind: 'TRANSITIONED', from: state, to: PaystackFundingState.REVERSED };
  }

  private async findLostDispute(flow: ClaimedFlow, payment: FundingPayment, transactionId: string): Promise<PaystackDispute | null> {
    const from = new Date((payment.createdAt ?? flow.stateChangedAt).getTime() - 24 * 3600 * 1000);
    const to = new Date(this.clock.now().getTime() + 24 * 3600 * 1000);
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const listed = await this.paystack.listDisputes({ from, to, transactionId, ...(cursor ? { cursor } : {}) });
      const lost = listed.items.find(
        (dispute) => dispute.transactionId === transactionId && dispute.status === 'resolved' && dispute.resolution === LOST_DISPUTE_RESOLUTION,
      );
      if (lost) return lost;
      if (!listed.nextCursor) return null;
      cursor = listed.nextCursor;
    }
    throw new ProviderUnavailableError('Paystack dispute list did not end', 'list-disputes');
  }

  // ── shared ──

  private async fail(
    flow: ClaimedFlow,
    runtime: FlowStepRuntime,
    from: PaystackFundingState,
    failureCode: string,
    update: FundingPaymentUpdate,
  ): Promise<StepOutcome> {
    assertPaystackTransition(from, PaystackFundingState.FAILED);
    await runtime.commit(from, { to: PaystackFundingState.FAILED, complete: true }, async (manager) => {
      await this.payments.update(manager, flow.id, { ...update, failureCode });
      await this.recordTransition(flow, from, PaystackFundingState.FAILED, { failureCode });
    });
    return { kind: 'TRANSITIONED', from, to: PaystackFundingState.FAILED };
  }

  private recordTransition(
    flow: ClaimedFlow,
    from: PaystackFundingState,
    to: PaystackFundingState,
    after: { failureCode?: string; transactionId?: string },
  ): Promise<void> {
    return this.audit.record({
      actor: { type: 'SYSTEM' },
      action: AuditAction.FUNDING_STATE_CHANGED,
      subject: { type: AuditSubjectType.FLOW, id: flow.id },
      before: { flowState: from },
      after: { flowState: to, ...after },
      reason: `paystack funding flow ${from} → ${to}`,
    });
  }
}
