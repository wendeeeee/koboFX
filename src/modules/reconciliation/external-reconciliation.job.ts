import { Inject, Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { FlowRunner } from '../flows/flow-runner';
import { FundingPaymentRepository } from '../flows/funding/funding-payment.repository';
import { PaymentProvider, ProviderChargebackRecord, ProviderPayment, ProviderPaymentStatus } from '../payments/payment-provider.port';
import { ProviderResponseInvalidError } from '../payments/payment.errors';
import { parseWebhookHint } from '../payments/webhooks/webhook-payload';
import { BREAK_POLICIES, BreakType, subjectKeys } from './break-types';
import { BreakStatus, ResolutionKind } from './break-transitions';
import { BreakService, Detection, ReconciliationBreak } from './break.service';
import { ReconciliationCheckpoint, ReconciliationCheckpoints } from './reconciliation-checkpoints';
import { ReconciliationMetrics } from './reconciliation-metrics';
import { ClaimedRun, ReconciliationRunRepository, ReconciliationRunStatus } from './reconciliation-run.repository';
import { SettlementIngestionService } from './settlement-ingestion.service';
import { RECONCILIATION_INITIATED_BY } from './settlement-posting';
import { isPastSettlementWindow, settlementDeadline } from './settlement-window';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 24 * 3600 * 1000;
const MAXIMUM_PAGES = 10_000;
/** PSP statuses under which money was taken from the cardholder. */
const CAPTURED_AT_PSP = new Set([ProviderPaymentStatus.CAPTURED, ProviderPaymentStatus.CHARGED_BACK]);

export interface ExternalRunResult {
  readonly runId: string;
  readonly status: ReconciliationRunStatus.CLEAN | ReconciliationRunStatus.BREAKS_FOUND;
  /** Every break this run detected (new or seen again), by id. */
  readonly detectedBreakIds: readonly string[];
  readonly resolvedBreakIds: readonly string[];
  readonly summary: Record<string, unknown>;
}

interface Deposit {
  readonly flowId: string;
  readonly flowState: string;
  readonly providerPaymentId: string | null;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly capturedAt: Date | null;
  readonly fundingTransactionId: string | null;
  readonly chargebackTransactionId: string | null;
  readonly settlementBatchLineId: string | null;
}

interface DepositRow {
  flow_id: string;
  state: string;
  provider_payment_id: string | null;
  currency_code: string;
  amount_minor: string;
  captured_at: Date | null;
  funding_transaction_id: string | null;
  chargeback_transaction_id: string | null;
  settlement_batch_line_id: string | null;
}

const DEPOSIT_COLUMNS = `funding_payments.flow_id, flow_instances.state, funding_payments.provider_payment_id,
  funding_payments.currency_code, funding_payments.amount_minor::text AS amount_minor, funding_payments.captured_at,
  funding_payments.funding_transaction_id, funding_payments.chargeback_transaction_id,
  funding_payments.settlement_batch_line_id`;

function toDeposit(row: DepositRow): Deposit {
  return {
    flowId: row.flow_id,
    flowState: row.state,
    providerPaymentId: row.provider_payment_id,
    currency: row.currency_code,
    amountMinor: BigInt(row.amount_minor),
    capturedAt: row.captured_at,
    fundingTransactionId: row.funding_transaction_id,
    chargebackTransactionId: row.chargeback_transaction_id,
    settlementBatchLineId: row.settlement_batch_line_id,
  };
}

/** Tracks what one run saw, for its status, its "no longer detected" sweep and its summary. */
class RunLedger {
  readonly detected = new Set<string>();
  readonly resolved = new Set<string>();
  readonly counts: Record<string, number> = {};

  note(detection: Detection, type: BreakType): void {
    this.detected.add(detection.breakId);
    this.counts[type] = (this.counts[type] ?? 0) + 1;
  }
}

/**
 * External reconciliation — our books against the PSP's (design §8.2; handbook: reconciliation,
 * Flow 2 step 5). Verifies the PSP against us AND us against the PSP; never edits a row to make
 * the two agree.
 *
 * DAILY:
 * 1. Settlements: every PAID batch settled in the lookback window (a late batch keeps its
 *    settlement date, so the window re-reads it) → `SettlementIngestionService`. Then any
 *    deposit already settled whose flow is still POSTED is finished.
 * 2. Completeness, both ways, on the PSP's own ids: captured payments we never booked
 *    (`MISSING_IN_LEDGER` → drive the flow; `PAYMENT_WITHOUT_FLOW`) and deposits we booked that
 *    the PSP does not have captured (`MISSING_AT_PSP`) — payments by creation date; and
 *    chargebacks we have not reversed (→ drive the completed flow) — by the CHARGEBACK's creation
 *    date, since a dispute lands months after its payment, outside any payment lookback.
 * 3. Timing: a booked deposit with no settlement line past its T+X window is
 *    `UNSETTLED_PAST_WINDOW`; one settled late (or reversed) resolves with that line (or reversal).
 * 4. `UNMATCHED` webhooks: the stored raw payload is reprocessed.
 * 5. The receivable proof (Phase 9 plan §E), in one read-only snapshot.
 * 6. Live breaks of the re-derived types that this run no longer saw, with no named cause, are
 *    escalated as "no longer detected" — never silently resolved.
 *
 * HOURLY: funding flows unresolved for longer than `RECONCILIATION_UNRESOLVED_FLOW_AGE_MINUTES`
 * are checked against the PSP and driven (the webhook that never arrived), and automatic
 * resolutions of live breaks are retried.
 *
 * Every step is idempotent, so a run that dies half-way is resumed by re-running it.
 */
@Injectable()
export class ExternalReconciliationJob {
  private readonly logger = new Logger(ExternalReconciliationJob.name);

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly provider: PaymentProvider,
    private readonly runner: FlowRunner,
    private readonly fundingPayments: FundingPaymentRepository,
    private readonly ingestion: SettlementIngestionService,
    private readonly breaks: BreakService,
    private readonly runs: ReconciliationRunRepository,
    private readonly metrics: ReconciliationMetrics,
    private readonly checkpoints: ReconciliationCheckpoints,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get providerName(): string {
    return this.config.paymentProvider.name;
  }

  async runDaily(run: ClaimedRun): Promise<ExternalRunResult> {
    const now = this.clock.now();
    const since = new Date(now.getTime() - this.config.reconciliation.lookbackDays * DAY);
    const seen = new RunLedger();
    const settlement = await this.ingestSettlements(run, since, now, seen);
    const settledFlows = await this.ingestion.settlePendingFlows();
    await this.heartbeat(run);
    await this.checkCompleteness(run, since, now, seen);
    await this.checkChargebacks(run, since, now, seen);
    await this.heartbeat(run);
    await this.checkSettlementWindows(run, now, seen);
    await this.reprocessUnmatchedWebhooks(run, seen);
    await this.proveReceivables(run, seen);
    // A cause may exist by now (a resumer posted the flow): look for it BEFORE calling anything stale.
    await this.retryAutomaticResolutions(seen);
    await this.escalateNoLongerDetected(run, seen);
    return this.finish(run, seen, { ...settlement, settledFlows });
  }

  async runHourly(run: ClaimedRun): Promise<ExternalRunResult> {
    const seen = new RunLedger();
    const driven = await this.driveUnresolvedFlows(run, this.clock.now(), seen);
    await this.retryAutomaticResolutions(seen);
    const settledFlows = await this.ingestion.settlePendingFlows();
    return this.finish(run, seen, { unresolvedFlowsDriven: driven, settledFlows });
  }

  // ── 1. settlements ─────────────────────────────────────────────────────────

  private async ingestSettlements(run: ClaimedRun, since: Date, now: Date, seen: RunLedger): Promise<Record<string, number>> {
    const counts = { batchesListed: 0, batchesPosted: 0, batchesRejected: 0, batchesChanged: 0, batchesUnchanged: 0 };
    let cursor: string | undefined;
    for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
      // Up to and INCLUDING now: the PSP's ranges are half-open.
      const listed = await this.provider.listSettlementBatches({ settledFrom: since, settledTo: new Date(now.getTime() + 1), ...(cursor ? { cursor } : {}) });
      for (const summary of listed.items) {
        counts.batchesListed += 1;
        if (summary.status !== 'PAID') continue; // money that has not moved is not settled
        let batch;
        try {
          batch = await this.provider.getSettlementBatch(summary.batchId);
        } catch (error) {
          if (!(error instanceof ProviderResponseInvalidError)) throw error;
          // Unreadable after every retry: nothing enters the system; a human is told.
          const detection = await this.breaks.detectAndRecord(run.id, {
            type: BreakType.SETTLEMENT_REPORT_REJECTED,
            subjectKey: subjectKeys.batch(this.providerName, summary.batchId),
            currency: summary.currency,
            amountMinor: 0n,
            details: { batchId: summary.batchId, rejection: 'UNREADABLE', error: error.message.slice(0, 300) },
          });
          seen.note(detection, BreakType.SETTLEMENT_REPORT_REJECTED);
          continue;
        }
        if (batch.status !== 'PAID') continue;
        const outcome = await this.ingestion.ingest(run, batch);
        switch (outcome.kind) {
          case 'POSTED':
            counts.batchesPosted += 1;
            break;
          case 'REJECTED':
            counts.batchesRejected += 1;
            break;
          case 'CHANGED':
            counts.batchesChanged += 1;
            break;
          default:
            counts.batchesUnchanged += 1;
        }
        if ('detections' in outcome) {
          for (const detection of outcome.detections) seen.note(detection, (await this.breaks.findById(detection.breakId))!.type);
        }
      }
      if (!listed.nextCursor) break;
      cursor = listed.nextCursor;
    }
    return counts;
  }

  // ── 2. completeness ────────────────────────────────────────────────────────

  private async checkCompleteness(run: ClaimedRun, since: Date, now: Date, seen: RunLedger): Promise<void> {
    const cutoff = new Date(now.getTime() - this.config.reconciliation.unresolvedFlowAgeMinutes * 60_000);
    const pspPaymentIds = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
      const listed = await this.provider.listPayments({ createdFrom: since, createdTo: new Date(now.getTime() + 1), ...(cursor ? { cursor } : {}) });
      for (const payment of listed.items) {
        pspPaymentIds.add(payment.paymentId);
        await this.checkPspPayment(run, payment, cutoff, seen);
      }
      if (!listed.nextCursor) break;
      cursor = listed.nextCursor;
    }

    // Our side: deposits we booked in the window that the PSP's list did not show — confirm
    // with a direct read before calling them missing (lists can lag or paginate oddly).
    const booked = (await this.unitOfWork.manager.query(
      `SELECT ${DEPOSIT_COLUMNS}
         FROM funding_payments JOIN flow_instances ON flow_instances.id = funding_payments.flow_id
        WHERE funding_payments.provider = $1 AND funding_payments.funding_transaction_id IS NOT NULL
          AND funding_payments.captured_at >= $2 AND funding_payments.captured_at <= $3
        ORDER BY funding_payments.captured_at, funding_payments.flow_id`,
      [this.providerName, since, now],
    )) as DepositRow[];
    for (const deposit of booked.map(toDeposit)) {
      if (!deposit.providerPaymentId || pspPaymentIds.has(deposit.providerPaymentId)) continue;
      const payment = await this.provider.findPayment(deposit.providerPaymentId, { flowId: deposit.flowId });
      if (!payment || !CAPTURED_AT_PSP.has(payment.status)) await this.missingAtPsp(run, deposit, payment, seen);
    }
  }

  private async checkPspPayment(run: ClaimedRun, payment: ProviderPayment, cutoff: Date, seen: RunLedger): Promise<void> {
    const deposit = await this.depositForPsp(payment);
    if (!CAPTURED_AT_PSP.has(payment.status)) {
      if (deposit?.fundingTransactionId) await this.missingAtPsp(run, deposit, payment, seen);
      return;
    }
    // Still inside the normal webhook/resumer window: the flow's own business, not a break.
    if (!payment.capturedAt || payment.capturedAt.getTime() > cutoff.getTime()) return;

    if (!deposit) {
      const detection = await this.breaks.detectAndRecord(run.id, {
        type: BreakType.PAYMENT_WITHOUT_FLOW,
        subjectKey: subjectKeys.payment(this.providerName, payment.paymentId),
        currency: payment.amount.currency,
        amountMinor: payment.amount.amountMinor,
        providerPaymentId: payment.paymentId,
        details: { providerPaymentId: payment.paymentId, pspStatus: payment.status, amountMinor: payment.amount.toMinorString(), source: 'PAYMENT_LIST' },
      });
      seen.note(detection, BreakType.PAYMENT_WITHOUT_FLOW);
      return;
    }
    if (deposit.currency !== payment.amount.currency || deposit.amountMinor !== payment.amount.amountMinor) {
      const type = deposit.currency !== payment.amount.currency ? BreakType.CURRENCY_MISMATCH : BreakType.AMOUNT_MISMATCH;
      const detection = await this.breaks.detectAndRecord(run.id, {
        type,
        subjectKey: subjectKeys.payment(this.providerName, payment.paymentId),
        currency: payment.amount.currency,
        amountMinor: payment.amount.amountMinor,
        flowId: deposit.flowId,
        providerPaymentId: payment.paymentId,
        details: {
          providerPaymentId: payment.paymentId,
          pspAmountMinor: payment.amount.toMinorString(),
          pspCurrency: payment.amount.currency,
          bookedAmountMinor: deposit.amountMinor.toString(),
          bookedCurrency: deposit.currency,
          source: 'PAYMENT_LIST',
        },
      });
      seen.note(detection, type);
      return;
    }
    if (!deposit.fundingTransactionId) await this.missingInLedger(run, deposit, payment, seen);
  }

  /**
   * Every chargeback the PSP opened in the lookback (by ITS date) against a deposit we booked
   * and have not reversed — once old enough that its webhook should have been processed.
   */
  private async checkChargebacks(run: ClaimedRun, since: Date, now: Date, seen: RunLedger): Promise<void> {
    const cutoff = new Date(now.getTime() - this.config.reconciliation.unresolvedFlowAgeMinutes * 60_000);
    let cursor: string | undefined;
    for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
      const listed = await this.provider.listChargebacks({ createdFrom: since, createdTo: new Date(now.getTime() + 1), ...(cursor ? { cursor } : {}) });
      for (const chargeback of listed.items) {
        if (chargeback.createdAt.getTime() > cutoff.getTime()) continue;
        const [row] = (await this.unitOfWork.manager.query(
          `SELECT ${DEPOSIT_COLUMNS}
             FROM funding_payments JOIN flow_instances ON flow_instances.id = funding_payments.flow_id
            WHERE funding_payments.provider = $1 AND funding_payments.provider_payment_id = $2`,
          [this.providerName, chargeback.paymentId],
        )) as DepositRow[];
        const deposit = row ? toDeposit(row) : null;
        // A chargeback on a payment we never booked is that payment's own break (completeness).
        if (!deposit?.fundingTransactionId || deposit.chargebackTransactionId) continue;
        await this.chargebackNotReversed(run, deposit, chargeback, seen);
      }
      if (!listed.nextCursor) break;
      cursor = listed.nextCursor;
    }
  }

  /** The deposit a PSP payment belongs to: by its id, else by our reference (the flow id). */
  private async depositForPsp(payment: ProviderPayment): Promise<Deposit | null> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT ${DEPOSIT_COLUMNS}
         FROM funding_payments JOIN flow_instances ON flow_instances.id = funding_payments.flow_id
        WHERE (funding_payments.provider = $1 AND funding_payments.provider_payment_id = $2)
           OR ($3::uuid IS NOT NULL AND funding_payments.flow_id = $3::uuid)
        ORDER BY (funding_payments.provider_payment_id = $2) DESC NULLS LAST
        LIMIT 1`,
      [this.providerName, payment.paymentId, UUID.test(payment.reference) ? payment.reference : null],
    )) as DepositRow[];
    return row ? toDeposit(row) : null;
  }

  private async missingAtPsp(run: ClaimedRun, deposit: Deposit, payment: ProviderPayment | null, seen: RunLedger): Promise<void> {
    const paymentId = deposit.providerPaymentId ?? payment?.paymentId ?? deposit.flowId;
    const detection = await this.breaks.detectAndRecord(run.id, {
      type: BreakType.MISSING_AT_PSP,
      subjectKey: subjectKeys.payment(this.providerName, paymentId),
      currency: deposit.currency,
      amountMinor: deposit.amountMinor,
      flowId: deposit.flowId,
      providerPaymentId: paymentId,
      details: {
        providerPaymentId: paymentId,
        pspStatus: payment?.status ?? 'NOT_FOUND',
        bookedAmountMinor: deposit.amountMinor.toString(),
        fundingTransactionId: deposit.fundingTransactionId,
      },
    });
    seen.note(detection, BreakType.MISSING_AT_PSP);
  }

  /**
   * Captured at the PSP long enough ago, not in our ledger: the webhook never came and the
   * resumer has not caught up. Recorded, then resolved by driving the flow — the flow asks the
   * PSP itself (a hint, even from us, is never a fact).
   */
  private async missingInLedger(run: ClaimedRun, deposit: Deposit, payment: ProviderPayment, seen: RunLedger): Promise<void> {
    const detection = await this.breaks.detectAndRecord(run.id, {
      type: BreakType.MISSING_IN_LEDGER,
      subjectKey: subjectKeys.payment(this.providerName, payment.paymentId),
      currency: payment.amount.currency,
      amountMinor: payment.amount.amountMinor,
      flowId: deposit.flowId,
      providerPaymentId: payment.paymentId,
      details: {
        providerPaymentId: payment.paymentId,
        pspStatus: payment.status,
        capturedAt: payment.capturedAt?.toISOString() ?? null,
        flowState: deposit.flowState,
        source: 'PAYMENT_LIST',
      },
    });
    seen.note(detection, BreakType.MISSING_IN_LEDGER);
    await this.driveAndResolve(detection.breakId, deposit.flowId, seen);
  }

  private async chargebackNotReversed(run: ClaimedRun, deposit: Deposit, chargeback: ProviderChargebackRecord, seen: RunLedger): Promise<void> {
    const partial = chargeback.amount.currency !== deposit.currency || chargeback.amount.amountMinor !== deposit.amountMinor;
    const detection = await this.breaks.detectAndRecord(run.id, {
      type: BreakType.CHARGEBACK_NOT_REVERSED,
      subjectKey: subjectKeys.flow(deposit.flowId),
      currency: deposit.currency,
      amountMinor: chargeback.amount.amountMinor,
      flowId: deposit.flowId,
      providerPaymentId: chargeback.paymentId,
      details: {
        providerPaymentId: chargeback.paymentId,
        chargebackId: chargeback.chargebackId,
        chargebackAmountMinor: chargeback.amount.toMinorString(),
        bookedAmountMinor: deposit.amountMinor.toString(),
        flowState: deposit.flowState,
        partial,
      },
    });
    seen.note(detection, BreakType.CHARGEBACK_NOT_REVERSED);
    if (partial) {
      // Phase 5 decision 3: a partial chargeback waits for an approved CORRECTION (Phase 10).
      await this.breaks.escalate(detection.breakId, RECONCILIATION_INITIATED_BY, 'Partial chargeback: needs an approved CORRECTION (Phase 10).');
      return;
    }
    await this.driveAndResolve(detection.breakId, deposit.flowId, seen);
  }

  /**
   * Drive a flow through `FlowRunner` (completed flows included: a chargeback reverses a POSTED
   * or SETTLED funding), then resolve its break if — and only if — the row that proves it now
   * exists: the funding posting (`FLOW_ADVANCED`) or the chargeback's reversal (`REVERSAL_POSTED`).
   */
  private async driveAndResolve(breakId: string, flowId: string, seen: RunLedger): Promise<boolean> {
    const current = await this.breaks.findById(breakId);
    if (!current || current.status === BreakStatus.RESOLVED) return false;
    await this.runner.advance(flowId, { includeCompleted: true });
    const payment = await this.fundingPayments.findByFlowId(flowId);
    if (current.type === BreakType.MISSING_IN_LEDGER && payment?.fundingTransactionId) {
      if (current.details.settledIntoClearing === true) return false; // its money is in CLEARING: Phase 10
      await this.breaks.resolve(breakId, RECONCILIATION_INITIATED_BY, ResolutionKind.FLOW_ADVANCED, payment.fundingTransactionId, 'flow driven: funding posted');
      seen.resolved.add(breakId);
      return true;
    }
    if (current.type === BreakType.CHARGEBACK_NOT_REVERSED && payment?.chargebackTransactionId) {
      await this.breaks.resolve(breakId, RECONCILIATION_INITIATED_BY, ResolutionKind.REVERSAL_POSTED, payment.chargebackTransactionId, 'flow driven: chargeback reversed');
      seen.resolved.add(breakId);
      return true;
    }
    return false;
  }

  // ── 3. timing ──────────────────────────────────────────────────────────────

  private async checkSettlementWindows(run: ClaimedRun, now: Date, seen: RunLedger): Promise<void> {
    // First, the live ones: settled late or reversed since ⇒ a named cause.
    for (const live of await this.breaks.live([BreakType.UNSETTLED_PAST_WINDOW])) {
      if (!live.flowId) continue;
      const payment = await this.fundingPayments.findByFlowId(live.flowId);
      const [line] = (await this.unitOfWork.manager.query(`SELECT settlement_batch_line_id FROM funding_payments WHERE flow_id = $1`, [
        live.flowId,
      ])) as { settlement_batch_line_id: string | null }[];
      if (line?.settlement_batch_line_id) {
        await this.breaks.resolve(live.id, RECONCILIATION_INITIATED_BY, ResolutionKind.SETTLED_LATE, line.settlement_batch_line_id, 'settled after its window');
        seen.resolved.add(live.id);
      } else if (payment?.chargebackTransactionId) {
        await this.breaks.resolve(live.id, RECONCILIATION_INITIATED_BY, ResolutionKind.REVERSAL_POSTED, payment.chargebackTransactionId, 'reversed before it was settled; nothing left to settle');
        seen.resolved.add(live.id);
      }
    }

    const unsettled = (await this.unitOfWork.manager.query(
      `SELECT ${DEPOSIT_COLUMNS}
         FROM funding_payments JOIN flow_instances ON flow_instances.id = funding_payments.flow_id
        WHERE funding_payments.provider = $1 AND funding_payments.funding_transaction_id IS NOT NULL
          AND funding_payments.settlement_batch_line_id IS NULL AND flow_instances.state = 'POSTED'
          AND NOT EXISTS (SELECT 1 FROM settlement_batch_lines
                           WHERE settlement_batch_lines.provider = funding_payments.provider
                             AND settlement_batch_lines.provider_payment_id = funding_payments.provider_payment_id)
        ORDER BY funding_payments.captured_at, funding_payments.flow_id`,
      [this.providerName],
    )) as DepositRow[];
    for (const deposit of unsettled.map(toDeposit)) {
      const window = this.config.reconciliation.settlementWindows.get(deposit.currency);
      if (!window || !deposit.capturedAt || !deposit.providerPaymentId) continue;
      if (!isPastSettlementWindow(deposit.capturedAt, window, now)) continue;
      const subjectKey = subjectKeys.payment(this.providerName, deposit.providerPaymentId);
      // One discrepancy, one break: a deposit a mismatch already explains is not ALSO late.
      const [owned] = (await this.unitOfWork.manager.query(
        `SELECT 1 FROM reconciliation_breaks WHERE subject_key = $1 AND status <> 'RESOLVED' AND type <> 'UNSETTLED_PAST_WINDOW' LIMIT 1`,
        [subjectKey],
      )) as unknown[];
      if (owned) continue;
      const detection = await this.breaks.detectAndRecord(run.id, {
        type: BreakType.UNSETTLED_PAST_WINDOW,
        subjectKey,
        currency: deposit.currency,
        amountMinor: deposit.amountMinor,
        flowId: deposit.flowId,
        providerPaymentId: deposit.providerPaymentId,
        details: {
          providerPaymentId: deposit.providerPaymentId,
          capturedAt: deposit.capturedAt.toISOString(),
          deadline: settlementDeadline(deposit.capturedAt, window).toISOString(),
          businessDays: window.businessDays,
          graceHours: window.graceHours,
        },
      });
      seen.note(detection, BreakType.UNSETTLED_PAST_WINDOW);
    }
  }

  // ── 4. unmatched webhooks ──────────────────────────────────────────────────

  /**
   * `UNMATCHED` webhook events are evidence (Phase 5 decision 6), never dropped: each becomes a
   * break, and its STORED raw payload is reprocessed (ids only). A flow that now matches is
   * driven and the break resolved `WEBHOOK_REPROCESSED`; otherwise a human is told.
   */
  private async reprocessUnmatchedWebhooks(run: ClaimedRun, seen: RunLedger): Promise<void> {
    const events = (await this.unitOfWork.manager.query(
      `SELECT webhook_events.id, webhook_events.raw_payload
         FROM webhook_events
        WHERE webhook_events.outcome = 'UNMATCHED'
          AND NOT EXISTS (SELECT 1 FROM reconciliation_breaks
                           WHERE reconciliation_breaks.type = 'UNMATCHED_WEBHOOK'
                             AND reconciliation_breaks.webhook_event_id = webhook_events.id
                             AND reconciliation_breaks.status <> 'OPEN')
        ORDER BY webhook_events.received_at, webhook_events.id
        LIMIT 500`,
    )) as { id: string; raw_payload: Buffer }[];
    for (const event of events) {
      const detection = await this.breaks.detectAndRecord(run.id, {
        type: BreakType.UNMATCHED_WEBHOOK,
        subjectKey: subjectKeys.webhook(event.id),
        currency: null,
        amountMinor: 0n,
        webhookEventId: event.id,
        details: { webhookEventId: event.id },
      });
      seen.note(detection, BreakType.UNMATCHED_WEBHOOK);
      const hint = parseWebhookHint(event.raw_payload);
      const flowId = hint
        ? ((await this.fundingPayments.findFlowIdByProviderPayment(this.providerName, hint.paymentId)) ??
          (hint.reference && UUID.test(hint.reference) && (await this.fundingPayments.findByFlowId(hint.reference)) ? hint.reference : null))
        : null;
      if (flowId) {
        await this.runner.advance(flowId, { includeCompleted: true });
        await this.breaks.resolve(detection.breakId, RECONCILIATION_INITIATED_BY, ResolutionKind.WEBHOOK_REPROCESSED, flowId, 'stored payload reprocessed: matches a funding flow');
        seen.resolved.add(detection.breakId);
        continue;
      }
      const payment = hint ? await this.provider.findPayment(hint.paymentId, {}) : null;
      const why = !hint
        ? 'the stored payload names no payment'
        : !payment
          ? 'the PSP does not know the payment either'
          : 'the payment is under a reference that is no flow of ours (see its PAYMENT_WITHOUT_FLOW break)';
      await this.breaks.escalate(detection.breakId, RECONCILIATION_INITIATED_BY, `Unmatched webhook reprocessed: ${why}.`);
    }
  }

  // ── 5. the receivable proof ────────────────────────────────────────────────

  /**
   * `PSP_RECEIVABLE` per currency (every bucket) must equal what the deposits' own facts say is
   * owed to us: + each booked deposit, − each settled, − what each booked chargeback took from the receivable
   * (all of it for a reversal, the disputed part for a partial CORRECTION), + each deduction the PSP made. Measured in ONE read-only snapshot, so a concurrent posting cannot fake a gap.
   */
  private async proveReceivables(run: ClaimedRun, seen: RunLedger): Promise<void> {
    const rows = await this.unitOfWork.runReadOnlySnapshot(
      async (manager) =>
        (await manager.query(
          `WITH expected AS (
             -- Each term is what the ledger actually moved on the receivable for that fact (Phase 10: a partial
             -- chargeback moves only its disputed part; a full one, and every settlement, the whole amount).
             SELECT funding_payments.currency_code AS currency,
                    sum(
                      funding_payments.amount_minor
                      - CASE WHEN funding_payments.settlement_batch_line_id IS NOT NULL THEN funding_payments.amount_minor ELSE 0 END
                      - COALESCE((SELECT sum(ledger_entries.amount_minor) FROM ledger_entries
                                   JOIN accounts ON accounts.id = ledger_entries.account_id
                                  WHERE ledger_entries.transaction_id = funding_payments.chargeback_transaction_id
                                    AND accounts.code LIKE 'PSP_RECEIVABLE:%' AND ledger_entries.direction = 'CREDIT'), 0)
                      + COALESCE((SELECT sum(settlement_batch_lines.amount_minor) FROM settlement_batch_lines
                                  WHERE settlement_batch_lines.flow_id = funding_payments.flow_id
                                    AND settlement_batch_lines.line_type = 'CHARGEBACK'
                                    AND settlement_batch_lines.attribution = 'ATTRIBUTED'), 0)
                    ) AS minor
               FROM funding_payments
              WHERE funding_payments.funding_transaction_id IS NOT NULL
              GROUP BY funding_payments.currency_code
           ), actual AS (
             SELECT accounts.currency_code AS currency, sum(accounts.balance_minor) AS minor
               FROM accounts
              WHERE accounts.code LIKE 'PSP_RECEIVABLE:%' AND accounts.wallet_id IS NULL
              GROUP BY accounts.currency_code
           )
           SELECT coalesce(expected.currency, actual.currency) AS currency,
                  coalesce(expected.minor, 0)::text AS expected_minor, coalesce(actual.minor, 0)::text AS actual_minor
             FROM expected FULL JOIN actual ON actual.currency = expected.currency
            ORDER BY 1`,
        )) as { currency: string; expected_minor: string; actual_minor: string }[],
      { statementTimeoutMilliseconds: this.config.reconciliation.statementTimeoutSeconds * 1000 },
    );
    for (const row of rows) {
      const difference = BigInt(row.actual_minor) - BigInt(row.expected_minor);
      if (difference === 0n) continue;
      const detection = await this.breaks.detectAndRecord(run.id, {
        type: BreakType.RECEIVABLE_PROOF_FAILED,
        subjectKey: `receivable:${row.currency}`,
        currency: row.currency,
        amountMinor: difference < 0n ? -difference : difference,
        details: { expectedMinor: row.expected_minor, actualMinor: row.actual_minor },
      });
      seen.note(detection, BreakType.RECEIVABLE_PROOF_FAILED);
    }
  }

  // ── 6. no longer detected ──────────────────────────────────────────────────

  private async escalateNoLongerDetected(run: ClaimedRun, seen: RunLedger): Promise<void> {
    const types = (Object.keys(BREAK_POLICIES) as BreakType[]).filter((type) => BREAK_POLICIES[type].rederivedBy === 'EXTERNAL_DAILY');
    for (const live of await this.breaks.live(types)) {
      if (seen.detected.has(live.id) || seen.resolved.has(live.id)) continue;
      const note = `No longer detected by external run ${run.id} (${run.periodKey}); not resolved: no cause was named.`;
      if (!(await this.breaks.escalate(live.id, RECONCILIATION_INITIATED_BY, note))) await this.breaks.annotate(live.id, note);
    }
  }

  // ── hourly ─────────────────────────────────────────────────────────────────

  /**
   * Funding flows still unresolved after the configured age (design §10 pages on "PENDING funding
   * older than 1h"): ask the PSP. Captured there long enough ago ⇒ the webhook never arrived ⇒ a
   * `MISSING_IN_LEDGER` break, resolved by driving the flow. Otherwise the flow is just driven.
   */
  private async driveUnresolvedFlows(run: ClaimedRun, now: Date, seen: RunLedger): Promise<number> {
    const cutoff = new Date(now.getTime() - this.config.reconciliation.unresolvedFlowAgeMinutes * 60_000);
    const rows = (await this.unitOfWork.manager.query(
      `SELECT ${DEPOSIT_COLUMNS}
         FROM flow_instances JOIN funding_payments ON funding_payments.flow_id = flow_instances.id
        WHERE flow_instances.flow_type = 'FUNDING' AND flow_instances.completed_at IS NULL AND flow_instances.created_at < $1
        ORDER BY flow_instances.created_at, flow_instances.id
        LIMIT 500`,
      [cutoff],
    )) as DepositRow[];
    for (const deposit of rows.map(toDeposit)) {
      const payment = deposit.providerPaymentId
        ? await this.provider.findPayment(deposit.providerPaymentId, { flowId: deposit.flowId })
        : await this.provider.findPaymentByReference(deposit.flowId, { flowId: deposit.flowId });
      const capturedLongAgo =
        payment !== null && CAPTURED_AT_PSP.has(payment.status) && payment.capturedAt !== null && payment.capturedAt.getTime() <= cutoff.getTime();
      if (payment && capturedLongAgo && !deposit.fundingTransactionId) {
        await this.missingInLedger(run, deposit, payment, seen);
      } else {
        await this.runner.advance(deposit.flowId);
      }
    }
    return rows.length;
  }

  /** Live breaks an automatic resolution may still close: drive their flows again. */
  private async retryAutomaticResolutions(seen: RunLedger): Promise<void> {
    const live: ReconciliationBreak[] = await this.breaks.live([BreakType.MISSING_IN_LEDGER, BreakType.CHARGEBACK_NOT_REVERSED]);
    for (const candidate of live) {
      if (!candidate.flowId || candidate.details.partial === true || candidate.details.settledIntoClearing === true) continue;
      await this.driveAndResolve(candidate.id, candidate.flowId, seen);
    }
  }

  // ── bookkeeping ────────────────────────────────────────────────────────────

  private async heartbeat(run: ClaimedRun): Promise<void> {
    await this.runs.heartbeat(run, this.config.reconciliation.leaseSeconds);
  }

  private async finish(run: ClaimedRun, seen: RunLedger, counts: Record<string, number>): Promise<ExternalRunResult> {
    const status = seen.detected.size === 0 ? ReconciliationRunStatus.CLEAN : ReconciliationRunStatus.BREAKS_FOUND;
    const drift = await this.externalDrift();
    const summary = {
      clean: status === ReconciliationRunStatus.CLEAN,
      ...counts,
      breaksDetected: seen.detected.size,
      breaksResolved: seen.resolved.size,
      detectedByType: seen.counts,
      driftMinor: Object.fromEntries([...drift.entries()].map(([currency, minor]) => [currency, minor.toString()])),
    };
    await this.checkpoints.reached(ReconciliationCheckpoint.BEFORE_FINISH, { runId: run.id, kind: run.kind });
    await this.runs.finish(run, status, summary, null);
    this.metrics.recordDrift('external', drift);
    const log = { runId: run.id, kind: run.kind, periodKey: run.periodKey, status, detected: seen.detected.size, resolved: seen.resolved.size };
    if (status === ReconciliationRunStatus.CLEAN) this.logger.log(log, 'External reconciliation finished');
    else this.logger.warn(log, 'External reconciliation found breaks');
    return { runId: run.id, status, detectedBreakIds: [...seen.detected], resolvedBreakIds: [...seen.resolved], summary };
  }

  /** External drift: Σ amount of LIVE money breaks, per currency (never across currencies). */
  private async externalDrift(): Promise<Map<string, bigint>> {
    const moneyTypes = (Object.keys(BREAK_POLICIES) as BreakType[]).filter(
      (type) => BREAK_POLICIES[type].severity === 'MONEY' && BREAK_POLICIES[type].rederivedBy !== 'INTERNAL',
    );
    const rows = (await this.unitOfWork.manager.query(
      `SELECT currencies.code AS currency, coalesce(sum(reconciliation_breaks.amount_minor), 0)::text AS drift
         FROM currencies
         LEFT JOIN reconciliation_breaks
           ON reconciliation_breaks.currency_code = currencies.code AND reconciliation_breaks.status <> 'RESOLVED'
          AND reconciliation_breaks.type = ANY($1::reconciliation_break_type[])
        WHERE currencies.is_active
        GROUP BY currencies.code ORDER BY currencies.code`,
      [moneyTypes],
    )) as { currency: string; drift: string }[];
    return new Map(rows.map((row) => [row.currency, BigInt(row.drift)]));
  }
}

