import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { FlowRunner } from '../flows/flow-runner';
import { FlowType } from '../flows/flow.types';
import { FundingPaymentRepository } from '../flows/funding/funding-payment.repository';
import { PaystackFundingState } from '../flows/paystack-funding/paystack-funding-transitions';
import { PaystackDispute, PaystackGateway, PaystackTransaction } from '../payments/paystack/paystack-gateway.port';
import { PaystackTransactionStatus } from '../payments/paystack/paystack-status';
import { parsePaystackWebhookHint } from '../payments/paystack/webhooks/paystack-webhook-payload';
import { BREAK_POLICIES, BreakType, subjectKeys } from './break-types';
import { BreakStatus, ResolutionKind } from './break-transitions';
import { BreakCandidate, BreakService } from './break.service';
import { ExternalRunResult } from './external-reconciliation.job';
import { BreakOwnership, ProviderReconciliation, ProviderReconciliationRegistry } from './provider-reconciliation';
import { ClaimedRun, ReconciliationRunRepository, ReconciliationRunStatus } from './reconciliation-run.repository';
import { RECONCILIATION_INITIATED_BY } from './settlement-posting';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 24 * 3600 * 1000;
const MAXIMUM_PAGES = 10_000;
const LOST_DISPUTE_RESOLUTION = 'merchant-accepted';

interface PaystackDeposit {
  readonly flowId: string;
  readonly flowState: string;
  readonly providerPaymentId: string | null;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly fundingTransactionId: string | null;
  readonly chargebackTransactionId: string | null;
}

interface DepositRow {
  flow_id: string;
  state: string;
  provider_payment_id: string | null;
  currency_code: string;
  amount_minor: string;
  funding_transaction_id: string | null;
  chargeback_transaction_id: string | null;
}

const DEPOSIT_COLUMNS = `funding_payments.flow_id, flow_instances.state, funding_payments.provider_payment_id,
  funding_payments.currency_code, funding_payments.amount_minor::text AS amount_minor,
  funding_payments.funding_transaction_id, funding_payments.chargeback_transaction_id`;

function toDeposit(row: DepositRow): PaystackDeposit {
  return {
    flowId: row.flow_id,
    flowState: row.state,
    providerPaymentId: row.provider_payment_id,
    currency: row.currency_code,
    amountMinor: BigInt(row.amount_minor),
    fundingTransactionId: row.funding_transaction_id,
    chargebackTransactionId: row.chargeback_transaction_id,
  };
}

class Seen {
  readonly detected = new Set<string>();
  readonly resolved = new Set<string>();
  readonly counts: Record<string, number> = {};

  note(breakId: string, type: BreakType): void {
    this.detected.add(breakId);
    this.counts[type] = (this.counts[type] ?? 0) + 1;
  }
}

/**
 * External reconciliation of Paystack (PAYSTACK_PLAN.md C7) — our books against Paystack's, both ways, on Paystack's
 * own ids and OUR reference, through the same `BreakService` and taxonomy as the simulated PSP's, in runs of its own
 * (`reconciliation_runs.provider = 'paystack'`). Never edits a row to make the two agree.
 *
 * DAILY:
 * 1. Every Paystack transaction in the lookback (`listTransactions`, by creation date): a success old enough that the
 *    flow should have it — with no funding of ours → `PAYMENT_WITHOUT_FLOW`; on a funding we FAILED (paid after the
 *    checkout window — a late success) → `PAYMENT_WITHOUT_FLOW` naming the failed flow; with another amount or
 *    currency (a HELD funding) → `AMOUNT_MISMATCH` / `CURRENCY_MISMATCH`; not yet booked → `MISSING_IN_LEDGER`,
 *    resolved by driving the flow. A booked deposit Paystack now reports `reversed` → `MISSING_AT_PSP`.
 * 2. Our side: deposits we booked in the window that the list did not show are verified one by one.
 * 3. Disputes (by the DISPUTE's date): lost in full against a booked deposit not yet reversed →
 *    `CHARGEBACK_NOT_REVERSED`, resolved by driving the flow; partial → escalated for a human.
 * 4. `UNMATCHED` Paystack webhooks: a break each, the stored payload reprocessed.
 * 5. The receivable proof for `PAYSTACK_RECEIVABLE`, in one read-only snapshot.
 * 6. This provider's live breaks that no run sees any more are escalated "no longer detected" — never resolved.
 *
 * HOURLY: Paystack fundings unresolved past the configured age are verified and driven; HELD ones raise their
 * mismatch break (a flow cannot raise a break itself: breaks belong to runs).
 *
 * Settlement ingestion is NOT done for Paystack (accepted risk, PAYSTACK_PLAN.md A15): `PAYSTACK_RECEIVABLE` is never
 * credited by a settlement, and no settlement-window check runs.
 */
@Injectable()
export class PaystackReconciliationJob implements ProviderReconciliation, OnModuleInit {
  readonly provider: string;
  private readonly logger = new Logger(PaystackReconciliationJob.name);

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly paystack: PaystackGateway,
    private readonly runner: FlowRunner,
    private readonly fundingPayments: FundingPaymentRepository,
    private readonly breaks: BreakService,
    private readonly ownership: BreakOwnership,
    private readonly runs: ReconciliationRunRepository,
    private readonly registry: ProviderReconciliationRegistry,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.provider = config.paystack.name;
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async runDaily(run: ClaimedRun): Promise<ExternalRunResult> {
    const now = this.clock.now();
    const since = new Date(now.getTime() - this.config.reconciliation.lookbackDays * DAY);
    const seen = new Seen();
    const listed = await this.checkTransactions(run, since, now, seen);
    await this.heartbeat(run);
    await this.checkBookedDeposits(run, since, now, listed, seen);
    await this.checkDisputes(run, since, now, seen);
    await this.heartbeat(run);
    await this.reprocessUnmatchedWebhooks(run, seen);
    await this.proveReceivable(run, seen);
    await this.retryAutomaticResolutions(seen);
    await this.escalateNoLongerDetected(run, seen);
    return this.finish(run, seen, { transactionsListed: listed.size });
  }

  async runHourly(run: ClaimedRun): Promise<ExternalRunResult> {
    const seen = new Seen();
    const driven = await this.driveUnresolvedFlows(run, this.clock.now(), seen);
    const held = await this.detectHeldFlows(run, seen);
    await this.retryAutomaticResolutions(seen);
    return this.finish(run, seen, { unresolvedFlowsDriven: driven, heldFlowsChecked: held });
  }

  // ── 1. Paystack's transactions ─────────────────────────────────────────────

  private async checkTransactions(run: ClaimedRun, since: Date, now: Date, seen: Seen): Promise<Set<string>> {
    const cutoff = this.cutoff(now);
    const listed = new Set<string>();
    let cursor: string | undefined;
    // Paystack's from/to inclusivity is undocumented: over-read by a day each side, then filter half-open ourselves.
    for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
      const result = await this.paystack.listTransactions({
        from: new Date(since.getTime() - DAY),
        to: new Date(now.getTime() + DAY),
        ...(cursor ? { cursor } : {}),
      });
      for (const transaction of result.items) {
        if (listed.has(transaction.transactionId)) continue; // a page shifted under us
        const created = transaction.createdAt ?? transaction.paidAt;
        if (created && (created.getTime() < since.getTime() || created.getTime() > now.getTime())) continue;
        listed.add(transaction.transactionId);
        await this.checkTransaction(run, transaction, cutoff, seen);
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return listed;
  }

  private async checkTransaction(run: ClaimedRun, transaction: PaystackTransaction, cutoff: Date, seen: Seen): Promise<void> {
    const deposit = await this.depositFor(transaction.transactionId, transaction.reference);
    if (transaction.status === PaystackTransactionStatus.REVERSED) {
      if (deposit?.fundingTransactionId && !deposit.chargebackTransactionId) await this.missingAtPaystack(run, deposit, transaction, seen);
      return;
    }
    if (transaction.status !== PaystackTransactionStatus.SUCCESS) return;
    // Still inside the normal webhook/resumer window: the flow's own business, not a break.
    if (!transaction.paidAt || transaction.paidAt.getTime() > cutoff.getTime()) return;
    const base = {
      subjectKey: subjectKeys.payment(this.provider, transaction.transactionId),
      currency: transaction.amount.currency,
      amountMinor: transaction.amount.amountMinor,
      providerPaymentId: transaction.transactionId,
    };
    if (!deposit || deposit.flowState === PaystackFundingState.FAILED) {
      await this.detect(run, seen, {
        ...base,
        type: BreakType.PAYMENT_WITHOUT_FLOW,
        ...(deposit ? { flowId: deposit.flowId } : {}),
        details: {
          providerPaymentId: transaction.transactionId,
          reference: transaction.reference,
          paystackStatus: transaction.status,
          amountMinor: transaction.amount.toMinorString(),
          paidAt: transaction.paidAt.toISOString(),
          // Paid after we failed the funding (its checkout window was over): the money is real and owed.
          lateSuccess: deposit !== null,
          failedFlowId: deposit?.flowId ?? null,
          source: 'PAYMENT_LIST',
        },
      });
      return;
    }
    if (deposit.currency !== transaction.amount.currency || deposit.amountMinor !== transaction.amount.amountMinor) {
      await this.detectMismatch(run, seen, deposit, transaction, 'PAYMENT_LIST');
      return;
    }
    if (!deposit.fundingTransactionId) {
      const detection = await this.detect(run, seen, {
        ...base,
        type: BreakType.MISSING_IN_LEDGER,
        flowId: deposit.flowId,
        details: { providerPaymentId: transaction.transactionId, paystackStatus: transaction.status, paidAt: transaction.paidAt.toISOString(), flowState: deposit.flowState, source: 'PAYMENT_LIST' },
      });
      await this.driveAndResolve(detection, deposit.flowId, seen);
    }
  }

  private detectMismatch(run: ClaimedRun, seen: Seen, deposit: PaystackDeposit, transaction: PaystackTransaction, source: string): Promise<string> {
    const type = deposit.currency !== transaction.amount.currency ? BreakType.CURRENCY_MISMATCH : BreakType.AMOUNT_MISMATCH;
    return this.detect(run, seen, {
      type,
      subjectKey: subjectKeys.payment(this.provider, transaction.transactionId),
      currency: transaction.amount.currency,
      amountMinor: transaction.amount.amountMinor,
      flowId: deposit.flowId,
      providerPaymentId: transaction.transactionId,
      details: {
        providerPaymentId: transaction.transactionId,
        paystackAmountMinor: transaction.amount.toMinorString(),
        paystackCurrency: transaction.amount.currency,
        requestedAmountMinor: deposit.amountMinor.toString(),
        requestedCurrency: deposit.currency,
        flowState: deposit.flowState,
        source,
      },
    });
  }

  // ── 2. our side ────────────────────────────────────────────────────────────

  private async checkBookedDeposits(run: ClaimedRun, since: Date, now: Date, listed: Set<string>, seen: Seen): Promise<void> {
    const booked = (await this.unitOfWork.manager.query(
      `SELECT ${DEPOSIT_COLUMNS}
         FROM funding_payments JOIN flow_instances ON flow_instances.id = funding_payments.flow_id
        WHERE funding_payments.provider = $1 AND funding_payments.funding_transaction_id IS NOT NULL
          AND funding_payments.chargeback_transaction_id IS NULL
          AND funding_payments.captured_at >= $2 AND funding_payments.captured_at <= $3
        ORDER BY funding_payments.captured_at, funding_payments.flow_id`,
      [this.provider, since, now],
    )) as DepositRow[];
    for (const deposit of booked.map(toDeposit)) {
      if (deposit.providerPaymentId && listed.has(deposit.providerPaymentId)) continue;
      const transaction = await this.paystack.verify(deposit.flowId, { flowId: deposit.flowId });
      if (!transaction || transaction.status !== PaystackTransactionStatus.SUCCESS) await this.missingAtPaystack(run, deposit, transaction, seen);
    }
  }

  private async missingAtPaystack(run: ClaimedRun, deposit: PaystackDeposit, transaction: PaystackTransaction | null, seen: Seen): Promise<void> {
    const paymentId = deposit.providerPaymentId ?? transaction?.transactionId ?? deposit.flowId;
    await this.detect(run, seen, {
      type: BreakType.MISSING_AT_PSP,
      subjectKey: subjectKeys.payment(this.provider, paymentId),
      currency: deposit.currency,
      amountMinor: deposit.amountMinor,
      flowId: deposit.flowId,
      providerPaymentId: paymentId,
      details: {
        providerPaymentId: paymentId,
        paystackStatus: transaction?.status ?? 'NOT_FOUND',
        bookedAmountMinor: deposit.amountMinor.toString(),
        fundingTransactionId: deposit.fundingTransactionId,
      },
    });
  }

  // ── 3. disputes ────────────────────────────────────────────────────────────

  private async checkDisputes(run: ClaimedRun, since: Date, now: Date, seen: Seen): Promise<void> {
    const cutoff = this.cutoff(now);
    let cursor: string | undefined;
    for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
      const result = await this.paystack.listDisputes({ from: since, to: new Date(now.getTime() + DAY), ...(cursor ? { cursor } : {}) });
      for (const dispute of result.items) {
        if (dispute.status !== 'resolved' || dispute.resolution !== LOST_DISPUTE_RESOLUTION) continue;
        if ((dispute.resolvedAt ?? dispute.createdAt).getTime() > cutoff.getTime()) continue;
        const deposit = await this.depositFor(dispute.transactionId, dispute.transactionReference);
        // A dispute on a payment we never booked is that payment's own break (completeness).
        if (!deposit?.fundingTransactionId || deposit.chargebackTransactionId) continue;
        await this.chargebackNotReversed(run, deposit, dispute, seen);
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
  }

  private async chargebackNotReversed(run: ClaimedRun, deposit: PaystackDeposit, dispute: PaystackDispute, seen: Seen): Promise<void> {
    const amount = dispute.refundAmount;
    const partial = !amount || amount.currency !== deposit.currency || amount.amountMinor !== deposit.amountMinor;
    const breakId = await this.detect(run, seen, {
      type: BreakType.CHARGEBACK_NOT_REVERSED,
      subjectKey: subjectKeys.flow(deposit.flowId),
      currency: deposit.currency,
      amountMinor: amount?.amountMinor ?? deposit.amountMinor,
      flowId: deposit.flowId,
      providerPaymentId: dispute.transactionId,
      details: {
        providerPaymentId: dispute.transactionId,
        chargebackId: dispute.disputeId,
        chargebackAmountMinor: amount?.toMinorString() ?? null,
        bookedAmountMinor: deposit.amountMinor.toString(),
        flowState: deposit.flowState,
        partial,
      },
    });
    if (partial) {
      await this.breaks.escalate(breakId, RECONCILIATION_INITIATED_BY, 'Partial (or unstated) Paystack dispute: needs an approved CORRECTION (Phase 10).');
      return;
    }
    await this.driveAndResolve(breakId, deposit.flowId, seen);
  }

  // ── 4. unmatched webhooks ──────────────────────────────────────────────────

  private async reprocessUnmatchedWebhooks(run: ClaimedRun, seen: Seen): Promise<void> {
    const events = (await this.unitOfWork.manager.query(
      `SELECT webhook_events.id, webhook_events.raw_payload
         FROM webhook_events
        WHERE webhook_events.outcome = 'UNMATCHED' AND webhook_events.provider = $1
          AND NOT EXISTS (SELECT 1 FROM reconciliation_breaks
                           WHERE reconciliation_breaks.type = 'UNMATCHED_WEBHOOK'
                             AND reconciliation_breaks.webhook_event_id = webhook_events.id
                             AND reconciliation_breaks.status <> 'OPEN')
        ORDER BY webhook_events.received_at, webhook_events.id
        LIMIT 500`,
      [this.provider],
    )) as { id: string; raw_payload: Buffer }[];
    for (const event of events) {
      const breakId = await this.detect(run, seen, {
        type: BreakType.UNMATCHED_WEBHOOK,
        subjectKey: subjectKeys.webhook(event.id),
        currency: null,
        amountMinor: 0n,
        webhookEventId: event.id,
        details: { webhookEventId: event.id, provider: this.provider },
      });
      const hint = parsePaystackWebhookHint(event.raw_payload);
      const deposit = hint ? await this.depositFor(hint.transactionId, hint.reference) : null;
      if (deposit) {
        await this.runner.advance(deposit.flowId, { includeCompleted: true });
        await this.breaks.resolve(breakId, RECONCILIATION_INITIATED_BY, ResolutionKind.WEBHOOK_REPROCESSED, deposit.flowId, 'stored payload reprocessed: matches a Paystack funding');
        seen.resolved.add(breakId);
        continue;
      }
      const why = !hint
        ? 'the stored payload names no transaction'
        : 'it names no funding of ours (a paid one has its own PAYMENT_WITHOUT_FLOW break)';
      await this.breaks.escalate(breakId, RECONCILIATION_INITIATED_BY, `Unmatched Paystack webhook reprocessed: ${why}.`);
    }
  }

  // ── 5. the receivable proof ────────────────────────────────────────────────

  /**
   * `PAYSTACK_RECEIVABLE` per currency (every bucket) = + each booked Paystack deposit − what each booked chargeback
   * took from it. (No settlement ever credits it yet.) One read-only snapshot.
   */
  private async proveReceivable(run: ClaimedRun, seen: Seen): Promise<void> {
    const rows = await this.unitOfWork.runReadOnlySnapshot(
      async (manager) =>
        (await manager.query(
          `WITH expected AS (
             SELECT funding_payments.currency_code AS currency,
                    sum(funding_payments.amount_minor
                        - COALESCE((SELECT sum(ledger_entries.amount_minor) FROM ledger_entries
                                     JOIN accounts ON accounts.id = ledger_entries.account_id
                                    WHERE ledger_entries.transaction_id = funding_payments.chargeback_transaction_id
                                      AND accounts.code LIKE 'PAYSTACK_RECEIVABLE:%' AND ledger_entries.direction = 'CREDIT'), 0)
                    ) AS minor
               FROM funding_payments
              WHERE funding_payments.provider = $1 AND funding_payments.funding_transaction_id IS NOT NULL
              GROUP BY funding_payments.currency_code
           ), actual AS (
             SELECT accounts.currency_code AS currency, sum(accounts.balance_minor) AS minor
               FROM accounts
              WHERE accounts.code LIKE 'PAYSTACK_RECEIVABLE:%' AND accounts.wallet_id IS NULL
              GROUP BY accounts.currency_code
           )
           SELECT coalesce(expected.currency, actual.currency) AS currency,
                  coalesce(expected.minor, 0)::text AS expected_minor, coalesce(actual.minor, 0)::text AS actual_minor
             FROM expected FULL JOIN actual ON actual.currency = expected.currency
            ORDER BY 1`,
          [this.provider],
        )) as { currency: string; expected_minor: string; actual_minor: string }[],
      { statementTimeoutMilliseconds: this.config.reconciliation.statementTimeoutSeconds * 1000 },
    );
    for (const row of rows) {
      const difference = BigInt(row.actual_minor) - BigInt(row.expected_minor);
      if (difference === 0n) continue;
      await this.detect(run, seen, {
        type: BreakType.RECEIVABLE_PROOF_FAILED,
        subjectKey: `receivable:${this.provider}:${row.currency}`,
        currency: row.currency,
        amountMinor: difference < 0n ? -difference : difference,
        details: { expectedMinor: row.expected_minor, actualMinor: row.actual_minor, account: 'PAYSTACK_RECEIVABLE' },
      });
    }
  }

  // ── hourly ─────────────────────────────────────────────────────────────────

  private async driveUnresolvedFlows(run: ClaimedRun, now: Date, seen: Seen): Promise<number> {
    const cutoff = this.cutoff(now);
    const rows = (await this.unitOfWork.manager.query(
      `SELECT ${DEPOSIT_COLUMNS}
         FROM flow_instances JOIN funding_payments ON funding_payments.flow_id = flow_instances.id
        WHERE flow_instances.flow_type = $1 AND flow_instances.completed_at IS NULL AND flow_instances.created_at < $2
        ORDER BY flow_instances.created_at, flow_instances.id
        LIMIT 500`,
      [FlowType.PAYSTACK_FUNDING, cutoff],
    )) as DepositRow[];
    for (const deposit of rows.map(toDeposit)) {
      const transaction = await this.paystack.verify(deposit.flowId, { flowId: deposit.flowId });
      const paidLongAgo =
        transaction?.status === PaystackTransactionStatus.SUCCESS && transaction.paidAt !== null && transaction.paidAt.getTime() <= cutoff.getTime();
      if (transaction && paidLongAgo && !deposit.fundingTransactionId) {
        const breakId = await this.detect(run, seen, {
          type: BreakType.MISSING_IN_LEDGER,
          subjectKey: subjectKeys.payment(this.provider, transaction.transactionId),
          currency: transaction.amount.currency,
          amountMinor: transaction.amount.amountMinor,
          flowId: deposit.flowId,
          providerPaymentId: transaction.transactionId,
          details: { providerPaymentId: transaction.transactionId, paystackStatus: transaction.status, flowState: deposit.flowState, source: 'UNRESOLVED_FLOW' },
        });
        await this.driveAndResolve(breakId, deposit.flowId, seen);
      } else {
        await this.runner.advance(deposit.flowId);
      }
    }
    return rows.length;
  }

  /** HELD fundings (paid, but not what we asked): their mismatch break, from verify (PAYSTACK_PLAN.md B3). */
  private async detectHeldFlows(run: ClaimedRun, seen: Seen): Promise<number> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT ${DEPOSIT_COLUMNS}
         FROM flow_instances JOIN funding_payments ON funding_payments.flow_id = flow_instances.id
        WHERE flow_instances.flow_type = $1 AND flow_instances.state = $2
          AND NOT EXISTS (SELECT 1 FROM reconciliation_breaks
                           WHERE reconciliation_breaks.flow_id = flow_instances.id
                             AND reconciliation_breaks.type IN ('AMOUNT_MISMATCH', 'CURRENCY_MISMATCH'))
        ORDER BY flow_instances.created_at, flow_instances.id
        LIMIT 500`,
      [FlowType.PAYSTACK_FUNDING, PaystackFundingState.HELD],
    )) as DepositRow[];
    for (const deposit of rows.map(toDeposit)) {
      const transaction = await this.paystack.verify(deposit.flowId, { flowId: deposit.flowId });
      if (!transaction) {
        this.logger.error({ flowId: deposit.flowId }, 'A HELD Paystack funding is unknown to Paystack');
        continue;
      }
      await this.detectMismatch(run, seen, deposit, transaction, 'HELD_FLOW');
    }
    return rows.length;
  }

  // ── shared ─────────────────────────────────────────────────────────────────

  /** Our funding for a Paystack transaction: by its id once recorded, else by our reference (a Paystack flow's id). */
  private async depositFor(transactionId: string | null, reference: string | null): Promise<PaystackDeposit | null> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT ${DEPOSIT_COLUMNS}
         FROM funding_payments JOIN flow_instances ON flow_instances.id = funding_payments.flow_id
        WHERE funding_payments.provider = $1
          AND ((funding_payments.provider_payment_id IS NOT NULL AND funding_payments.provider_payment_id = $2)
               OR ($3::uuid IS NOT NULL AND funding_payments.flow_id = $3::uuid))
        ORDER BY (funding_payments.provider_payment_id = $2) DESC NULLS LAST
        LIMIT 1`,
      [this.provider, transactionId, reference && UUID.test(reference) ? reference : null],
    )) as DepositRow[];
    return row ? toDeposit(row) : null;
  }

  private cutoff(now: Date): Date {
    return new Date(now.getTime() - this.config.reconciliation.unresolvedFlowAgeMinutes * 60_000);
  }

  private async detect(run: ClaimedRun, seen: Seen, candidate: BreakCandidate): Promise<string> {
    const detection = await this.breaks.detectAndRecord(run.id, candidate);
    seen.note(detection.breakId, candidate.type);
    return detection.breakId;
  }

  /** Drive the flow; resolve only when the row that proves it exists (the posting, or the reversal). */
  private async driveAndResolve(breakId: string, flowId: string, seen: Seen): Promise<boolean> {
    const current = await this.breaks.findById(breakId);
    if (!current || current.status === BreakStatus.RESOLVED) return false;
    await this.runner.advance(flowId, { includeCompleted: true });
    const payment = await this.fundingPayments.findByFlowId(flowId);
    if (current.type === BreakType.MISSING_IN_LEDGER && payment?.fundingTransactionId) {
      await this.breaks.resolve(breakId, RECONCILIATION_INITIATED_BY, ResolutionKind.FLOW_ADVANCED, payment.fundingTransactionId, 'flow driven: Paystack funding posted');
      seen.resolved.add(breakId);
      return true;
    }
    if (current.type === BreakType.CHARGEBACK_NOT_REVERSED && payment?.chargebackTransactionId) {
      await this.breaks.resolve(breakId, RECONCILIATION_INITIATED_BY, ResolutionKind.REVERSAL_POSTED, payment.chargebackTransactionId, 'flow driven: Paystack dispute reversed');
      seen.resolved.add(breakId);
      return true;
    }
    return false;
  }

  private async retryAutomaticResolutions(seen: Seen): Promise<void> {
    for (const candidate of await this.breaks.live([BreakType.MISSING_IN_LEDGER, BreakType.CHARGEBACK_NOT_REVERSED])) {
      if (!candidate.flowId || candidate.details.partial === true) continue;
      if ((await this.ownership.providerOf(candidate)) !== this.provider) continue;
      await this.driveAndResolve(candidate.id, candidate.flowId, seen);
    }
  }

  private async escalateNoLongerDetected(run: ClaimedRun, seen: Seen): Promise<void> {
    const types = (Object.keys(BREAK_POLICIES) as BreakType[]).filter((type) => BREAK_POLICIES[type].rederivedBy === 'EXTERNAL_DAILY');
    for (const live of await this.breaks.live(types)) {
      if (seen.detected.has(live.id) || seen.resolved.has(live.id)) continue;
      if ((await this.ownership.providerOf(live)) !== this.provider) continue;
      const note = `No longer detected by Paystack run ${run.id} (${run.periodKey}); not resolved: no cause was named.`;
      if (!(await this.breaks.escalate(live.id, RECONCILIATION_INITIATED_BY, note))) await this.breaks.annotate(live.id, note);
    }
  }

  private async heartbeat(run: ClaimedRun): Promise<void> {
    await this.runs.heartbeat(run, this.config.reconciliation.leaseSeconds);
  }

  private async finish(run: ClaimedRun, seen: Seen, counts: Record<string, number>): Promise<ExternalRunResult> {
    const status = seen.detected.size === 0 ? ReconciliationRunStatus.CLEAN : ReconciliationRunStatus.BREAKS_FOUND;
    const summary = {
      clean: status === ReconciliationRunStatus.CLEAN,
      provider: this.provider,
      ...counts,
      breaksDetected: seen.detected.size,
      breaksResolved: seen.resolved.size,
      detectedByType: seen.counts,
    };
    await this.runs.finish(run, status, summary, null);
    const log = { runId: run.id, kind: run.kind, provider: this.provider, periodKey: run.periodKey, status, detected: seen.detected.size };
    if (status === ReconciliationRunStatus.CLEAN) this.logger.log(log, 'Paystack reconciliation finished');
    else this.logger.warn(log, 'Paystack reconciliation found breaks');
    return { runId: run.id, status, detectedBreakIds: [...seen.detected], resolvedBreakIds: [...seen.resolved], summary };
  }
}
