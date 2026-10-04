import { createHash } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { InvariantViolationError } from '../../common/errors';
import { Money } from '../../common/money';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { FlowRunner } from '../flows/flow-runner';
import { FlowLeaseLostError } from '../flows/flow.errors';
import { ClaimedFlow, FlowCheckpoint, FlowDefinition, FlowStepRuntime, FlowType, StepOutcome } from '../flows/flow.types';
import {
  PaystackWithdrawalState,
  assertWithdrawalTransition,
  isPaystackWithdrawalState,
} from '../flows/paystack-withdrawal/paystack-withdrawal-transitions';
import { PeriodLockedError } from '../ledger/ledger.errors';
import { LedgerService } from '../ledger/ledger.service';
import { EntryDirection, PostingAuthorization, TransactionType } from '../ledger/ledger.types';
import {
  PaystackTransferCallFailedError,
  PaystackTransferRefusal,
  PaystackTransfersGateway,
  ProviderExchange,
  TransferCallFailureKind,
  TransferObservation,
  TransferStatusClassification,
} from '../payments/paystack/transfers/paystack-transfers.port';
import { ProtectedEvidenceService } from '../protection/protected-evidence.service';
import { ProtectionService } from '../protection/protection.service';
import { ReservationService } from '../reservations/reservation.service';
import { UserRepository } from '../users/user.repository';
import { UserStatus } from '../users/user.types';
import { resolvePayoutAccounts } from './withdrawal-accounts';
import { RECIPIENT_TYPE, WITHDRAWAL_INITIATED_BY, WithdrawalTrail, beneficiaryContext } from './withdrawal-records';
import {
  principalReferenceOf,
  principalReversalReferenceOf,
  providerDebitReferenceOf,
  providerFeeReferenceOf,
  providerReturnReferenceOf,
} from './withdrawal-references';
import { WithdrawalReviewReason, openReview, resolveReview } from './withdrawal-reviews';

interface WithdrawalRecord {
  flow_id: string;
  user_id: string;
  account_id: string;
  reservation_id: string;
  principal_minor: string;
  currency_code: string;
  provider_account_identity: string;
  provider_reference: string;
  internal_bucket: number;
  submission_attempts: number;
  provider_transfer_id: string | null;
  provider_transfer_code: string | null;
  principal_transaction_id: string | null;
  beneficiary_id: string;
  sealing_key_id: string;
  provider_recipient_code_sealed: Buffer;
  identity_fingerprint: Buffer;
  identity_fingerprint_key_id: string;
}

const POLL_BASE_SECONDS = 5;
const POLL_MAXIMUM_SECONDS = 300;
const REVIEW_RETRY_SECONDS = 3600;
const FAILURE_STATUSES = [
  TransferStatusClassification.FAILED,
  TransferStatusClassification.ABANDONED,
  TransferStatusClassification.BLOCKED,
  TransferStatusClassification.REJECTED,
  TransferStatusClassification.REVERSED,
];
const IN_FLIGHT_STATUSES = [TransferStatusClassification.PENDING, TransferStatusClassification.OTP, TransferStatusClassification.RECEIVED];

/** A step found its precondition changed under the owner lock (e.g. suspended meanwhile): retried, never half-applied. */
class WithdrawalPreconditionChangedError extends InvariantViolationError {}

/**
 * The payout (WITHDRAWAL_PLAN.md §E.2, §E.3, §F, §G; D2–D5):
 *
 * - RESERVED: the submission marker, committed under the owner's row lock taken BEFORE the flow's — a suspension that
 *   wins the lock cancels the unsent payout (release, FAILED); a marker that wins authorizes sending this payload.
 * - SUBMITTING / PROCESSING: verify the fixed reference FIRST; absent ⇒ count the attempt durably, then send the frozen
 *   request once (same reference forever: Paystack deduplicates). An answer to a send only binds ids and moves to
 *   PROCESSING — success is established by `transfer.verify` alone. Every answer is sealed evidence + an observation in
 *   the same transaction as what it causes.
 * - A matching verified success: provider debit (+ actual fee) and the customer's principal settled ONCE through
 *   `ReservationService.settle()`, the stash receipt and POSTED — one transaction (§G.1 step 6).
 * - A matching definitive failure: the hold released once, FAILED. A refusal of the FIRST send is definitive; after any
 *   lost answer a refusal proves nothing and is a review.
 * - POSTED: a matching full return reverses the principal exactly, books the provider return, appends the reversal
 *   receipt, REVERSED. Partial or contradictory answers are reviews; nothing is ever released on time alone.
 */
@Injectable()
export class WithdrawalFlow implements FlowDefinition, OnModuleInit {
  readonly flowType = FlowType.PAYSTACK_WITHDRAWAL;
  private readonly logger = new Logger(WithdrawalFlow.name);

  constructor(
    private readonly runner: FlowRunner,
    private readonly unitOfWork: UnitOfWork,
    private readonly gateway: PaystackTransfersGateway,
    private readonly protection: ProtectionService,
    private readonly evidence: ProtectedEvidenceService,
    private readonly ledger: LedgerService,
    private readonly reservations: ReservationService,
    private readonly users: UserRepository,
    private readonly trail: WithdrawalTrail,
  ) {}

  onModuleInit(): void {
    this.runner.register(this);
  }

  isHintSatisfied(state: string, eventType: string): boolean {
    if (!isPaystackWithdrawalState(state)) return false;
    const resolved: readonly string[] = {
      'transfer.success': [PaystackWithdrawalState.POSTED, PaystackWithdrawalState.REVERSED, PaystackWithdrawalState.FAILED],
      'transfer.failed': [PaystackWithdrawalState.FAILED, PaystackWithdrawalState.POSTED, PaystackWithdrawalState.REVERSED],
      'transfer.reversed': [PaystackWithdrawalState.REVERSED, PaystackWithdrawalState.FAILED],
    }[eventType] ?? [PaystackWithdrawalState.POSTED, PaystackWithdrawalState.FAILED, PaystackWithdrawalState.REVERSED];
    return resolved.includes(state);
  }

  async step(flow: ClaimedFlow, runtime: FlowStepRuntime): Promise<StepOutcome> {
    const state = flow.state;
    if (!isPaystackWithdrawalState(state)) throw new InvariantViolationError(`Unknown withdrawal state ${state}.`, { flowId: flow.id });
    switch (state) {
      case PaystackWithdrawalState.RESERVED:
        return this.authorize(runtime, await this.load(flow.id));
      case PaystackWithdrawalState.SUBMITTING:
      case PaystackWithdrawalState.PROCESSING:
        return this.progress(flow, runtime, state, await this.load(flow.id));
      case PaystackWithdrawalState.POSTED:
        return this.checkForReturn(flow, runtime, await this.load(flow.id));
      case PaystackWithdrawalState.FAILED:
      case PaystackWithdrawalState.REVERSED:
        return { kind: 'IDLE', state };
    }
  }

  // ── RESERVED: the marker, or the unsent cancellation ──

  private async authorize(runtime: FlowStepRuntime, record: WithdrawalRecord): Promise<StepOutcome> {
    const from = PaystackWithdrawalState.RESERVED;
    const profile = await this.users.findProfile(record.user_id);
    const suspended = profile?.status !== UserStatus.ACTIVE;
    const assertStatus = async (manager: EntityManager) => {
      const [row] = (await manager.query(`SELECT status FROM users WHERE id = $1`, [record.user_id])) as { status: UserStatus }[];
      if ((row?.status !== UserStatus.ACTIVE) !== suspended) throw new WithdrawalPreconditionChangedError('The owner\'s status changed; retrying.');
    };
    if (suspended) {
      assertWithdrawalTransition(from, PaystackWithdrawalState.FAILED);
      await runtime.commit(
        from,
        { to: PaystackWithdrawalState.FAILED, complete: true, note: 'USER_SUSPENDED' },
        async (manager) => {
          await assertStatus(manager);
          await this.reservations.release(record.reservation_id);
          await manager.query(`UPDATE paystack_withdrawals SET failed_at = now(), failure_code = 'USER_SUSPENDED' WHERE flow_id = $1`, [record.flow_id]);
          await this.trail.changed('WITHDRAWAL', record.flow_id, record.user_id, from, PaystackWithdrawalState.FAILED, { failureCode: 'USER_SUSPENDED' });
        },
        { lockOwnerFirst: true },
      );
      return { kind: 'TRANSITIONED', from, to: PaystackWithdrawalState.FAILED };
    }
    const recipientCode = await this.recipientCodeOf(record);
    assertWithdrawalTransition(from, PaystackWithdrawalState.SUBMITTING);
    await runtime.commit(
      from,
      { to: PaystackWithdrawalState.SUBMITTING },
      async (manager) => {
        await assertStatus(manager);
        await manager.query(
          `UPDATE paystack_withdrawals SET submission_started_at = now(), submission_payload_sha256 = $2 WHERE flow_id = $1`,
          [record.flow_id, payloadDigest(record, recipientCode)],
        );
        await this.trail.changed('WITHDRAWAL', record.flow_id, record.user_id, from, PaystackWithdrawalState.SUBMITTING);
      },
      { lockOwnerFirst: true },
    );
    return { kind: 'TRANSITIONED', from, to: PaystackWithdrawalState.SUBMITTING };
  }

  // ── SUBMITTING / PROCESSING ──

  private async progress(
    flow: ClaimedFlow,
    runtime: FlowStepRuntime,
    state: PaystackWithdrawalState.SUBMITTING | PaystackWithdrawalState.PROCESSING,
    record: WithdrawalRecord,
  ): Promise<StepOutcome> {
    let verified;
    try {
      verified = await this.gateway.verifyTransfer(record.provider_reference, { flowId: flow.id });
    } catch (error) {
      return this.unanswered(flow, runtime, state, error);
    }
    await runtime.checkpoint(FlowCheckpoint.AFTER_EXTERNAL_CALL);
    if (verified.found) return this.observe(flow, runtime, state, record, verified.observation, verified.exchange);
    if (state === PaystackWithdrawalState.PROCESSING) {
      // Paystack showed the transfer before; "not found" now is a lag or a contradiction — never a reason to resend or release.
      return this.waiting(flow, state, 'transfer seen before but not visible now');
    }
    return this.send(flow, runtime, record);
  }

  private async send(flow: ClaimedFlow, runtime: FlowStepRuntime, record: WithdrawalRecord): Promise<StepOutcome> {
    const state = PaystackWithdrawalState.SUBMITTING;
    const recipientCode = await this.recipientCodeOf(record);
    // Counted durably BEFORE the request leaves (fenced by this step's lease, which it keeps): only the first send's
    // refusal can ever be definitive.
    await this.countAttempt(flow);
    const attempt = record.submission_attempts + 1;
    let answer;
    try {
      answer = await this.gateway.initiateTransfer(
        {
          amountMinor: BigInt(record.principal_minor),
          currency: record.currency_code,
          recipientCode,
          reference: record.provider_reference,
          reason: 'KoboFX withdrawal',
        },
        { flowId: flow.id },
      );
    } catch (error) {
      await runtime.checkpoint(FlowCheckpoint.AFTER_EXTERNAL_CALL);
      return this.sendRefused(runtime, record, attempt, error);
    }
    await runtime.checkpoint(FlowCheckpoint.AFTER_EXTERNAL_CALL);
    const observation = answer.value;
    if (!this.sameTransfer(record, observation) || observation.classification === TransferStatusClassification.MALFORMED) {
      // The answer to our send is kept; verify decides. Never settle from an initiate answer.
      await runtime.commit(state, { retryInSeconds: POLL_BASE_SECONDS }, async (manager) => {
        await this.recordObservation(manager, record, answer.exchange, observation, 'SUBMISSION', null);
      });
      return { kind: 'PROGRESSED', state };
    }
    assertWithdrawalTransition(state, PaystackWithdrawalState.PROCESSING);
    await runtime.commit(state, { to: PaystackWithdrawalState.PROCESSING, retryInSeconds: POLL_BASE_SECONDS }, async (manager) => {
      await this.bindTransfer(manager, record, observation);
      await this.recordObservation(manager, record, answer.exchange, observation, 'SUBMISSION', await this.recipientFingerprint(record, observation));
      await this.trail.changed('WITHDRAWAL', record.flow_id, record.user_id, state, PaystackWithdrawalState.PROCESSING);
    });
    return { kind: 'TRANSITIONED', from: state, to: PaystackWithdrawalState.PROCESSING };
  }

  /** +1 send attempt, fenced by the step's lease token (flow row locked first, then the withdrawal). The lease is kept. */
  private async countAttempt(flow: ClaimedFlow): Promise<void> {
    await this.unitOfWork.run(async (manager) => {
      const [row] = (await manager.query(`SELECT state, lease_token FROM flow_instances WHERE id = $1 FOR UPDATE`, [flow.id])) as {
        state: string;
        lease_token: string | null;
      }[];
      if (row.lease_token !== flow.leaseToken || row.state !== PaystackWithdrawalState.SUBMITTING) throw new FlowLeaseLostError(flow.id);
      await manager.query(`UPDATE paystack_withdrawals SET submission_attempts = submission_attempts + 1 WHERE flow_id = $1`, [flow.id]);
    });
  }

  private async sendRefused(runtime: FlowStepRuntime, record: WithdrawalRecord, attempt: number, error: unknown): Promise<StepOutcome> {
    const state = PaystackWithdrawalState.SUBMITTING;
    if (!(error instanceof PaystackTransferCallFailedError) || error.kind === TransferCallFailureKind.TRANSIENT || error.kind === TransferCallFailureKind.INVALID) {
      // No usable answer: the transfer may or may not exist. Verify first next time; the same reference is safe to resend.
      return { kind: 'WAITING', state, reason: 'send unanswered; verifying next', retryInSeconds: POLL_BASE_SECONDS };
    }
    if (error.refusal === PaystackTransferRefusal.DUPLICATE_REFERENCE) {
      return { kind: 'WAITING', state, reason: 'duplicate reference: verifying', retryInSeconds: POLL_BASE_SECONDS };
    }
    const definitive =
      attempt === 1 &&
      error.kind === TransferCallFailureKind.REFUSED &&
      [PaystackTransferRefusal.INSUFFICIENT_BALANCE, PaystackTransferRefusal.ACCOUNT_NOT_RESOLVED, PaystackTransferRefusal.REJECTED].includes(error.refusal as PaystackTransferRefusal);
    if (!definitive) {
      const reason = error.kind === TransferCallFailureKind.CONFIGURATION ? WithdrawalReviewReason.PROVIDER_APPROVAL_REQUIRED : WithdrawalReviewReason.PROVIDER_RESPONSE_UNRESOLVED;
      await runtime.commit(state, { retryInSeconds: REVIEW_RETRY_SECONDS, note: `review: ${error.kind} ${error.refusal ?? ''}` }, async (manager) => {
        const evidenceId = await this.storeIfAny(error.exchange);
        await openReview(manager, { table: 'paystack_withdrawals', flowId: record.flow_id }, { reason, evidenceId });
      });
      return { kind: 'PROGRESSED', state };
    }
    const failureCode = `PROVIDER_REFUSED_${(error.refusal as string).toUpperCase()}`;
    assertWithdrawalTransition(state, PaystackWithdrawalState.FAILED);
    await runtime.commit(state, { to: PaystackWithdrawalState.FAILED, complete: true, note: failureCode }, async (manager) => {
      await this.lockWithdrawal(manager, record.flow_id);
      const { observationId, observedAt } = await this.recordRefusal(manager, record, error);
      await this.certify(manager, record, observationId, 'DEFINITIVE_FAILURE', observedAt, null);
      await this.reservations.release(record.reservation_id);
      await manager.query(`UPDATE paystack_withdrawals SET failed_at = now(), failure_code = $2 WHERE flow_id = $1`, [record.flow_id, failureCode]);
      await resolveReview(manager, { table: 'paystack_withdrawals', flowId: record.flow_id });
      await this.trail.changed('WITHDRAWAL', record.flow_id, record.user_id, state, PaystackWithdrawalState.FAILED, { failureCode });
    });
    return { kind: 'TRANSITIONED', from: state, to: PaystackWithdrawalState.FAILED };
  }

  /** A verify answer about OUR reference: matched or not, it is kept; only a match can move money. */
  private async observe(
    flow: ClaimedFlow,
    runtime: FlowStepRuntime,
    state: PaystackWithdrawalState.SUBMITTING | PaystackWithdrawalState.PROCESSING,
    record: WithdrawalRecord,
    observation: TransferObservation,
    exchange: ProviderExchange,
  ): Promise<StepOutcome> {
    const fingerprint = await this.recipientFingerprint(record, observation);
    const classification = observation.classification;
    if (classification === TransferStatusClassification.MALFORMED || classification === TransferStatusClassification.UNKNOWN) {
      return this.reviewWith(runtime, state, record, exchange, observation, fingerprint, WithdrawalReviewReason.PROVIDER_RESPONSE_UNRESOLVED, 'OPERATIONS');
    }
    if (!this.matches(record, observation, fingerprint)) {
      return this.reviewWith(runtime, state, record, exchange, observation, fingerprint, WithdrawalReviewReason.TRANSFER_MISMATCH, 'SECURITY');
    }
    if (IN_FLIGHT_STATUSES.includes(classification)) {
      const to = PaystackWithdrawalState.PROCESSING;
      if (state !== to) assertWithdrawalTransition(state, to);
      await runtime.commit(state, { to, retryInSeconds: backoff(flow.attempts) }, async (manager) => {
        await this.bindTransfer(manager, record, observation);
        const { observationId } = await this.recordObservation(manager, record, exchange, observation, 'RESUMER', fingerprint);
        if (classification !== TransferStatusClassification.PENDING) {
          await openReview(manager, { table: 'paystack_withdrawals', flowId: record.flow_id }, { reason: WithdrawalReviewReason.PROVIDER_APPROVAL_REQUIRED, observationId });
        }
        if (state !== to) await this.trail.changed('WITHDRAWAL', record.flow_id, record.user_id, state, to);
      });
      return state !== to ? { kind: 'TRANSITIONED', from: state, to } : { kind: 'PROGRESSED', state };
    }
    if (classification === TransferStatusClassification.SUCCESS) return this.complete(runtime, state, record, observation, exchange, fingerprint);
    if (FAILURE_STATUSES.includes(classification)) return this.failVerified(runtime, state, record, observation, exchange, fingerprint);
    return this.reviewWith(runtime, state, record, exchange, observation, fingerprint, WithdrawalReviewReason.PROVIDER_RESPONSE_UNRESOLVED, 'OPERATIONS');
  }

  /** §G.1 step 6, one transaction: debit + fee events, `settle()` once, links, receipt, POSTED. */
  private async complete(
    runtime: FlowStepRuntime,
    from: PaystackWithdrawalState.SUBMITTING | PaystackWithdrawalState.PROCESSING,
    record: WithdrawalRecord,
    observation: TransferObservation,
    exchange: ProviderExchange,
    fingerprint: Buffer | null,
  ): Promise<StepOutcome> {
    assertWithdrawalTransition(from, PaystackWithdrawalState.POSTED);
    const principal = Money.fromMinorString(record.principal_minor, record.currency_code);
    const work = async (manager: EntityManager) => {
      await this.lockWithdrawal(manager, record.flow_id);
      await this.bindTransfer(manager, record, observation);
      const { observationId, observedAt } = await this.recordObservation(manager, record, exchange, observation, 'RESUMER', fingerprint);
      const valueTime = observation.transferredAt ?? observedAt;
      const verificationId = await this.certify(manager, record, observationId, 'SUCCESS', observedAt, observation.transferredAt);

      await this.ledger.lockUserAccounts([record.account_id]);
      await manager.query(`SELECT id FROM reservations WHERE id = $1 FOR UPDATE`, [record.reservation_id]);
      const accounts = await resolvePayoutAccounts(manager, record.currency_code, record.internal_bucket);
      await this.ledger.lockInternalAccounts([accounts.payoutBalanceId, accounts.payoutInTransitId, accounts.transferFeesId]);

      const debit = await this.ledger.post({
        transaction: {
          type: TransactionType.SETTLEMENT,
          authorization: PostingAuthorization.SYSTEM_DRIVEN,
          valueTime,
          initiatedBy: WITHDRAWAL_INITIATED_BY,
          reference: providerDebitReferenceOf(record.flow_id),
          reasonCode: 'PAYSTACK_TRANSFER_DEBIT',
          externalReference: observation.transferId ?? undefined,
          metadata: { flowId: record.flow_id },
        },
        entries: [
          { account: { accountId: accounts.payoutInTransitId }, direction: EntryDirection.DEBIT, amount: principal },
          { account: { accountId: accounts.payoutBalanceId }, direction: EntryDirection.CREDIT, amount: principal },
        ],
      });
      await manager.query(
        `INSERT INTO withdrawal_accounting_events (withdrawal_id, event_kind, currency_code, amount_minor, transaction_id, evidence_basis, observation_id, provider_event_identity)
         VALUES ($1, 'PRINCIPAL_DEBIT', $2, $3, $4, 'TRANSFER_STATE', $5, $6)`,
        [record.flow_id, record.currency_code, record.principal_minor, debit.transactionId, observationId, `transfer:${observation.transferId}`],
      );
      if (observation.feeChargedMinor === null) {
        await openReview(manager, { table: 'paystack_withdrawals', flowId: record.flow_id }, { reason: WithdrawalReviewReason.FEE_EVIDENCE_MISSING, observationId });
      } else if (observation.feeChargedMinor > 0n) {
        const fee = Money.of(observation.feeChargedMinor, record.currency_code);
        const feePosting = await this.ledger.post({
          transaction: {
            type: TransactionType.SETTLEMENT,
            authorization: PostingAuthorization.SYSTEM_DRIVEN,
            valueTime,
            initiatedBy: WITHDRAWAL_INITIATED_BY,
            reference: providerFeeReferenceOf(record.flow_id, observation.transferId as string, 'transfer_fee'),
            reasonCode: 'PAYSTACK_TRANSFER_FEE',
            metadata: { flowId: record.flow_id },
          },
          entries: [
            { account: { accountId: accounts.transferFeesId }, direction: EntryDirection.DEBIT, amount: fee },
            { account: { accountId: accounts.payoutBalanceId }, direction: EntryDirection.CREDIT, amount: fee },
          ],
        });
        await manager.query(
          `INSERT INTO withdrawal_accounting_events (withdrawal_id, event_kind, currency_code, amount_minor, transaction_id, evidence_basis, observation_id,
             provider_event_identity, fee_component)
           VALUES ($1, 'PROVIDER_FEE', $2, $3, $4, 'TRANSFER_STATE', $5, $6, 'transfer_fee')`,
          [record.flow_id, record.currency_code, fee.toMinorString(), feePosting.transactionId, observationId, observation.transferId],
        );
      }

      const settled = await this.reservations.settle(record.reservation_id, {
        transaction: {
          type: TransactionType.WITHDRAWAL,
          valueTime,
          initiatedBy: `user:${record.user_id}`,
          reference: principalReferenceOf(record.flow_id),
          userId: record.user_id,
          reasonCode: 'PAYSTACK_WITHDRAWAL',
          externalReference: observation.transferId ?? undefined,
          metadata: { flowId: record.flow_id, provider: 'paystack' },
        },
        entries: [
          { account: { accountId: record.account_id }, direction: EntryDirection.DEBIT, amount: principal },
          { account: { accountId: accounts.payoutInTransitId }, direction: EntryDirection.CREDIT, amount: principal },
        ],
      });
      await manager.query(
        `UPDATE paystack_withdrawals SET principal_transaction_id = $2, confirmation_verification_id = $3, posted_at = now() WHERE flow_id = $1`,
        [record.flow_id, settled.settlementTransactionId, verificationId],
      );
      await manager.query(`SELECT record_stash_receipt($1, $2)`, [record.flow_id, verificationId]);
      if (observation.feeChargedMinor !== null) await resolveReview(manager, { table: 'paystack_withdrawals', flowId: record.flow_id });
      await this.trail.changed('WITHDRAWAL', record.flow_id, record.user_id, from, PaystackWithdrawalState.POSTED, {
        transactionId: settled.settlementTransactionId as string,
      });
    };
    try {
      await runtime.commit(from, { to: PaystackWithdrawalState.POSTED, complete: true }, work);
    } catch (error) {
      if (!(error instanceof PeriodLockedError)) throw error;
      return this.reviewWith(runtime, from, record, exchange, observation, fingerprint, WithdrawalReviewReason.PERIOD_LOCKED, 'OPERATIONS');
    }
    return { kind: 'TRANSITIONED', from, to: PaystackWithdrawalState.POSTED };
  }

  private async failVerified(
    runtime: FlowStepRuntime,
    from: PaystackWithdrawalState.SUBMITTING | PaystackWithdrawalState.PROCESSING,
    record: WithdrawalRecord,
    observation: TransferObservation,
    exchange: ProviderExchange,
    fingerprint: Buffer | null,
  ): Promise<StepOutcome> {
    const failureCode = observation.classification === TransferStatusClassification.REVERSED ? 'RETURNED_BEFORE_COMPLETION' : `TRANSFER_${observation.classification}`;
    assertWithdrawalTransition(from, PaystackWithdrawalState.FAILED);
    await runtime.commit(from, { to: PaystackWithdrawalState.FAILED, complete: true, note: failureCode }, async (manager) => {
      await this.lockWithdrawal(manager, record.flow_id);
      await this.bindTransfer(manager, record, observation);
      const { observationId, observedAt } = await this.recordObservation(manager, record, exchange, observation, 'RESUMER', fingerprint);
      await this.certify(manager, record, observationId, 'DEFINITIVE_FAILURE', observedAt, null);
      await this.reservations.release(record.reservation_id);
      await manager.query(`UPDATE paystack_withdrawals SET failed_at = now(), failure_code = $2 WHERE flow_id = $1`, [record.flow_id, failureCode]);
      await resolveReview(manager, { table: 'paystack_withdrawals', flowId: record.flow_id });
      await this.trail.changed('WITHDRAWAL', record.flow_id, record.user_id, from, PaystackWithdrawalState.FAILED, { failureCode });
    });
    return { kind: 'TRANSITIONED', from, to: PaystackWithdrawalState.FAILED };
  }

  // ── POSTED: a full return after success ──

  private async checkForReturn(flow: ClaimedFlow, runtime: FlowStepRuntime, record: WithdrawalRecord): Promise<StepOutcome> {
    const state = PaystackWithdrawalState.POSTED;
    const verified = await this.gateway.verifyTransfer(record.provider_reference, { flowId: flow.id });
    await runtime.checkpoint(FlowCheckpoint.AFTER_EXTERNAL_CALL);
    if (!verified.found || verified.observation.classification === TransferStatusClassification.SUCCESS) return { kind: 'IDLE', state };
    const observation = verified.observation;
    const fingerprint = await this.recipientFingerprint(record, observation);
    if (observation.classification !== TransferStatusClassification.REVERSED || !this.matches(record, observation, fingerprint)) {
      // `failed` after a verified success is contradictory, not a refund instruction; partial returns are reviews.
      return this.reviewWith(runtime, state, record, verified.exchange, observation, fingerprint, WithdrawalReviewReason.PARTIAL_RETURN, 'OPERATIONS');
    }
    const principalTransactionId = record.principal_transaction_id;
    if (!principalTransactionId) throw new InvariantViolationError('A posted withdrawal has no principal posting.', { flowId: flow.id });
    const principal = Money.fromMinorString(record.principal_minor, record.currency_code);
    assertWithdrawalTransition(state, PaystackWithdrawalState.REVERSED);
    await runtime.commit(state, { to: PaystackWithdrawalState.REVERSED }, async (manager) => {
      await this.lockWithdrawal(manager, record.flow_id);
      const { observationId, observedAt } = await this.recordObservation(manager, record, verified.exchange, observation, 'RESUMER', fingerprint);
      const verificationId = await this.certify(manager, record, observationId, 'FULL_RETURN', observedAt, null);
      await manager.query(`SELECT id FROM transactions WHERE id = $1 FOR UPDATE`, [principalTransactionId]);
      await this.ledger.lockUserAccounts([record.account_id]);
      const accounts = await resolvePayoutAccounts(manager, record.currency_code, record.internal_bucket);
      await this.ledger.lockInternalAccounts([accounts.payoutBalanceId, accounts.payoutInTransitId]);
      const request = await this.ledger.buildReversalRequest(principalTransactionId, {
        valueTime: observedAt,
        initiatedBy: WITHDRAWAL_INITIATED_BY,
        reasonCode: 'PAYSTACK_TRANSFER_REVERSED',
      });
      const reversal = await this.ledger.post({ transaction: { ...request.transaction, reference: principalReversalReferenceOf(record.flow_id) }, entries: request.entries });
      const providerReturn = await this.ledger.post({
        transaction: {
          type: TransactionType.SETTLEMENT,
          authorization: PostingAuthorization.SYSTEM_DRIVEN,
          valueTime: observedAt,
          initiatedBy: WITHDRAWAL_INITIATED_BY,
          reference: providerReturnReferenceOf(record.flow_id),
          reasonCode: 'PAYSTACK_TRANSFER_RETURN',
          metadata: { flowId: record.flow_id },
        },
        entries: [
          { account: { accountId: accounts.payoutBalanceId }, direction: EntryDirection.DEBIT, amount: principal },
          { account: { accountId: accounts.payoutInTransitId }, direction: EntryDirection.CREDIT, amount: principal },
        ],
      });
      const [{ id: debitEventId }] = (await manager.query(
        `SELECT id FROM withdrawal_accounting_events WHERE withdrawal_id = $1 AND event_kind = 'PRINCIPAL_DEBIT'`,
        [record.flow_id],
      )) as { id: string }[];
      await manager.query(
        `INSERT INTO withdrawal_accounting_events (withdrawal_id, event_kind, currency_code, amount_minor, transaction_id, evidence_basis, observation_id,
           original_event_id, provider_event_identity)
         VALUES ($1, 'PRINCIPAL_RETURN', $2, $3, $4, 'TRANSFER_STATE', $5, $6, $7)`,
        [record.flow_id, record.currency_code, record.principal_minor, providerReturn.transactionId, observationId, debitEventId, `transfer-return:${observation.transferId}`],
      );
      await manager.query(
        `UPDATE paystack_withdrawals SET reversal_transaction_id = $2, return_verification_id = $3, reversed_at = now() WHERE flow_id = $1`,
        [record.flow_id, reversal.transactionId, verificationId],
      );
      await manager.query(`SELECT record_stash_receipt($1, $2)`, [record.flow_id, verificationId]);
      await this.trail.changed('WITHDRAWAL', record.flow_id, record.user_id, state, PaystackWithdrawalState.REVERSED, { transactionId: reversal.transactionId });
    });
    return { kind: 'TRANSITIONED', from: state, to: PaystackWithdrawalState.REVERSED };
  }

  // ── shared ──

  private async load(flowId: string): Promise<WithdrawalRecord> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT w.flow_id, w.user_id, w.account_id, w.reservation_id, w.principal_minor::text AS principal_minor, w.currency_code,
              w.provider_account_identity, w.provider_reference, w.internal_bucket, w.submission_attempts, w.provider_transfer_id,
              w.provider_transfer_code, w.principal_transaction_id, d.beneficiary_id, d.sealing_key_id, d.provider_recipient_code_sealed,
              d.identity_fingerprint, d.identity_fingerprint_key_id
         FROM paystack_withdrawals w JOIN withdrawal_destinations d ON d.withdrawal_id = w.flow_id
        WHERE w.flow_id = $1`,
      [flowId],
    )) as WithdrawalRecord[];
    if (!row) throw new InvariantViolationError('A withdrawal flow has no withdrawal.', { flowId });
    return row;
  }

  private async recipientCodeOf(record: WithdrawalRecord): Promise<string> {
    const plain = await this.protection.open(
      { keyId: record.sealing_key_id, sealed: record.provider_recipient_code_sealed },
      beneficiaryContext(record.beneficiary_id, record.user_id, 'provider_recipient_code_sealed'),
    );
    return plain.toString('utf8');
  }

  /** The keyed fingerprint of the recipient Paystack names, under the destination's key version (null when it names none). */
  private async recipientFingerprint(record: WithdrawalRecord, observation: TransferObservation): Promise<Buffer | null> {
    const details = observation.recipient?.details;
    if (!details?.bankCode || !details.accountNumber) return null;
    return this.protection.destinationFingerprintWith(
      { userId: record.user_id, bankCode: details.bankCode, accountNumber: details.accountNumber, recipientType: RECIPIENT_TYPE, currency: record.currency_code },
      record.identity_fingerprint_key_id,
    ).digest;
  }

  private sameTransfer(record: WithdrawalRecord, observation: TransferObservation): boolean {
    return (
      observation.reference === record.provider_reference &&
      observation.amountMinor === BigInt(record.principal_minor) &&
      observation.currency === record.currency_code &&
      observation.domain === 'test' &&
      (record.provider_transfer_id === null || observation.transferId === record.provider_transfer_id) &&
      (record.provider_transfer_code === null || observation.transferCode === record.provider_transfer_code)
    );
  }

  private matches(record: WithdrawalRecord, observation: TransferObservation, fingerprint: Buffer | null): boolean {
    return this.sameTransfer(record, observation) && fingerprint !== null && fingerprint.equals(record.identity_fingerprint);
  }

  private async bindTransfer(manager: EntityManager, record: WithdrawalRecord, observation: TransferObservation): Promise<void> {
    if (record.provider_transfer_id !== null || !observation.transferId || !observation.transferCode) return;
    await manager.query(
      `UPDATE paystack_withdrawals SET provider_transfer_id = $2, provider_transfer_code = $3
        WHERE flow_id = $1 AND provider_transfer_id IS NULL`,
      [record.flow_id, observation.transferId, observation.transferCode],
    );
    record.provider_transfer_id = observation.transferId;
    record.provider_transfer_code = observation.transferCode;
  }

  private async lockWithdrawal(manager: EntityManager, flowId: string): Promise<void> {
    await manager.query(`SELECT flow_id FROM paystack_withdrawals WHERE flow_id = $1 FOR UPDATE`, [flowId]);
  }

  private async storeIfAny(exchange: ProviderExchange): Promise<string | undefined> {
    if (!exchange.rawResponse) return undefined;
    const stored = await this.evidence.store({ provider: 'paystack', operation: exchange.operation, content: exchange.rawResponse, providerCallId: exchange.providerCallId });
    return stored.evidenceId;
  }

  private async recordObservation(
    manager: EntityManager,
    record: WithdrawalRecord,
    exchange: ProviderExchange,
    observation: TransferObservation,
    source: 'RESUMER' | 'SUBMISSION',
    fingerprint: Buffer | null,
  ): Promise<{ observationId: string; observedAt: Date }> {
    const evidenceId = await this.storeIfAny(exchange);
    if (!evidenceId) throw new InvariantViolationError('An observation needs the answer\'s bytes as evidence.', { operation: exchange.operation });
    const [row] = (await manager.query(
      `INSERT INTO paystack_transfer_observations
         (withdrawal_id, provider_account_identity, operation, observed_domain, provider_reference, provider_transfer_id,
          provider_transfer_code, status_classification, raw_status, amount_minor, currency_code, recipient_identity_fingerprint,
          recipient_identity_fingerprint_key_id, provider_created_at, provider_updated_at, provider_transferred_at, fee_charged_minor,
          evidence_id, request_sha256, response_sha256, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, sha256($20::bytea), $21)
       RETURNING id, observed_at`,
      [
        observation.reference === record.provider_reference ? record.flow_id : null,
        record.provider_account_identity,
        exchange.operation,
        observation.domain,
        observation.reference,
        observation.transferId,
        observation.transferCode?.slice(0, 100) ?? null,
        observation.classification,
        observation.rawStatus,
        observation.amountMinor?.toString() ?? null,
        observation.currency,
        fingerprint,
        fingerprint ? record.identity_fingerprint_key_id : null,
        observation.createdAt,
        observation.updatedAt,
        observation.transferredAt,
        observation.feeChargedMinor?.toString() ?? null,
        evidenceId,
        exchange.requestSha256,
        exchange.rawResponse,
        source,
      ],
    )) as { id: string; observed_at: Date }[];
    return { observationId: row.id, observedAt: row.observed_at };
  }

  /** The refusal of the first send, as an observation the certificate can rest on (W3 amendment of the W1 check). */
  private async recordRefusal(manager: EntityManager, record: WithdrawalRecord, error: PaystackTransferCallFailedError): Promise<{ observationId: string; observedAt: Date }> {
    const evidenceId = await this.storeIfAny(error.exchange);
    if (!evidenceId) throw new InvariantViolationError('A refusal without bytes cannot certify a failure.');
    const [row] = (await manager.query(
      `INSERT INTO paystack_transfer_observations
         (withdrawal_id, provider_account_identity, operation, provider_reference, status_classification, raw_status, evidence_id,
          request_sha256, response_sha256, source)
       VALUES ($1, $2, 'transfer.initiate', $3, 'REJECTED', $4, $5, $6, sha256($7::bytea), 'SUBMISSION')
       RETURNING id, observed_at`,
      [record.flow_id, record.provider_account_identity, record.provider_reference, error.refusal, evidenceId, error.exchange.requestSha256, error.exchange.rawResponse],
    )) as { id: string; observed_at: Date }[];
    return { observationId: row.id, observedAt: row.observed_at };
  }

  private async certify(
    manager: EntityManager,
    record: WithdrawalRecord,
    observationId: string,
    outcome: 'SUCCESS' | 'DEFINITIVE_FAILURE' | 'FULL_RETURN',
    observedAt: Date,
    providerTime: Date | null,
  ): Promise<string> {
    const [row] = (await manager.query(
      `INSERT INTO withdrawal_verifications (withdrawal_id, user_id, currency_code, amount_minor, observation_id, outcome, value_time, value_time_basis)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [record.flow_id, record.user_id, record.currency_code, record.principal_minor, observationId, outcome, providerTime ?? observedAt,
        providerTime ? 'PROVIDER_EVENT_TIME' : 'OBSERVED_TEST_STATE'],
    )) as { id: string }[];
    return row.id;
  }

  private async reviewWith(
    runtime: FlowStepRuntime,
    state: PaystackWithdrawalState,
    record: WithdrawalRecord,
    exchange: ProviderExchange,
    observation: TransferObservation,
    fingerprint: Buffer | null,
    reason: WithdrawalReviewReason,
    owner: 'OPERATIONS' | 'SECURITY',
  ): Promise<StepOutcome> {
    this.logger.warn({ flowId: record.flow_id, reason, classification: observation.classification }, 'Withdrawal needs review; the hold stays');
    await runtime.commit(state, { retryInSeconds: REVIEW_RETRY_SECONDS, note: `review: ${reason}` }, async (manager) => {
      const { observationId } = await this.recordObservation(manager, record, exchange, observation, 'RESUMER', fingerprint);
      await openReview(manager, { table: 'paystack_withdrawals', flowId: record.flow_id }, { reason, owner, observationId });
    });
    return { kind: 'PROGRESSED', state };
  }

  /** No usable verify answer: unreadable or configuration answers are reviews (kept); transient ones just back off. */
  private async unanswered(flow: ClaimedFlow, runtime: FlowStepRuntime, state: PaystackWithdrawalState, error: unknown): Promise<StepOutcome> {
    if (!(error instanceof PaystackTransferCallFailedError) || error.kind === TransferCallFailureKind.TRANSIENT) throw error;
    const reason = error.kind === TransferCallFailureKind.CONFIGURATION ? WithdrawalReviewReason.PROVIDER_APPROVAL_REQUIRED : WithdrawalReviewReason.PROVIDER_RESPONSE_UNRESOLVED;
    await runtime.commit(state, { retryInSeconds: REVIEW_RETRY_SECONDS, note: `review: ${error.kind}` }, async (manager) => {
      const evidenceId = await this.storeIfAny(error.exchange);
      await openReview(manager, { table: 'paystack_withdrawals', flowId: flow.id }, { reason, evidenceId });
    });
    return { kind: 'PROGRESSED', state };
  }

  private waiting(flow: ClaimedFlow, state: PaystackWithdrawalState, reason: string): StepOutcome {
    return { kind: 'WAITING', state, reason, retryInSeconds: backoff(flow.attempts) };
  }
}

function backoff(attempts: number): number {
  return Math.min(POLL_MAXIMUM_SECONDS, POLL_BASE_SECONDS * 2 ** Math.min(attempts, 10));
}

function payloadDigest(record: WithdrawalRecord, recipientCode: string): Buffer {
  return createHash('sha256').update(['v1', record.provider_reference, record.principal_minor, record.currency_code, recipientCode].join('|'), 'utf8').digest();
}

