import { Inject, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { AuditAction, AuditLogService, AuditSubjectType } from '../audit/audit-log.service';
import { FlowRunner } from '../flows/flow-runner';
import { FundingPaymentRepository } from '../flows/funding/funding-payment.repository';
import { FundingState } from '../flows/funding/funding-transitions';
import { PeriodLockedError } from '../ledger/ledger.errors';
import { LedgerService } from '../ledger/ledger.service';
import { PaymentProvider, ProviderSettlementBatch, ProviderSettlementLineType } from '../payments/payment-provider.port';
import { BreakType, subjectKeys } from './break-types';
import { ResolutionKind } from './break-transitions';
import { BreakCandidate, BreakService, Detection } from './break.service';
import { ReconciliationCheckpoint, ReconciliationCheckpoints } from './reconciliation-checkpoints';
import { ClaimedRun } from './reconciliation-run.repository';
import {
  DetectedDiscrepancy,
  KnownDeposit,
  LineDecision,
  PaymentLookup,
  SettlementRejection,
  lockedPeriodDiscrepancy,
  matchSettlementBatch,
  settlementContentHash,
} from './settlement-matcher';
import { RECONCILIATION_INITIATED_BY, buildSettlementPosting } from './settlement-posting';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type IngestOutcome =
  /** We already hold exactly this report. */
  | { readonly kind: 'UNCHANGED' }
  /** Another worker ingested it between our read and our transaction. */
  | { readonly kind: 'ALREADY_INGESTED' }
  /** The report changed after we ingested it: a new version and a break; nothing re-posted. */
  | { readonly kind: 'CHANGED'; readonly detections: readonly Detection[] }
  | {
      readonly kind: 'POSTED';
      readonly batchRowId: string;
      readonly transactionId: string;
      readonly settledFlowIds: readonly string[];
      readonly detections: readonly Detection[];
    }
  | { readonly kind: 'REJECTED'; readonly batchRowId: string; readonly code: SettlementRejection; readonly detections: readonly Detection[] };

/**
 * One PSP settlement report in (Phase 9 plan §C, §E, §F; handbook Flow 2 step 5):
 *
 * 1. Already held? Same content ⇒ nothing. Different content ⇒ a new evidence version and a
 *    `SETTLEMENT_BATCH_CHANGED` break — never a re-post, never an edit.
 * 2. Outside any transaction (never hold one across a provider call): drive the flows of lines
 *    that name a deposit we have not booked yet (the webhook that never came), and ask the PSP
 *    about payment ids we do not know at all.
 * 3. Match (pure), then ONE transaction, serialised per batch by an advisory lock: the posting
 *    through `LedgerService.post()` (FIRST, so internal accounts are locked before
 *    `funding_payments` rows — the same order a chargeback's reversal takes), the batch, its
 *    lines, each settled deposit's facts, the evidence version, the breaks and their findings,
 *    the audit row. A settlement date in a locked period is refused by `post()` and recorded as
 *    a rejected batch with its break.
 * 4. After the commit: each settled deposit's flow POSTED → SETTLED through `FlowRunner`. A crash
 *    here is finished by the next run's settle sweep.
 */
@Injectable()
export class SettlementIngestionService {
  private readonly logger = new Logger(SettlementIngestionService.name);

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly provider: PaymentProvider,
    private readonly ledger: LedgerService,
    private readonly runner: FlowRunner,
    private readonly fundingPayments: FundingPaymentRepository,
    private readonly breaks: BreakService,
    private readonly audit: AuditLogService,
    private readonly checkpoints: ReconciliationCheckpoints,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get providerName(): string {
    return this.config.paymentProvider.name;
  }

  async ingest(run: ClaimedRun, batch: ProviderSettlementBatch): Promise<IngestOutcome> {
    const contentHash = settlementContentHash(batch);
    const existing = await this.findBatch(batch.batchId);
    if (existing) {
      if (existing.contentHash === contentHash) return { kind: 'UNCHANGED' };
      return this.recordChangedReport(run, batch, existing.id, contentHash);
    }

    await this.driveUnbookedDeposits(batch);
    const lookups = await this.lookUpUnknownPayments(batch);
    const outcome = await this.unitOfWork.run(async (manager) => {
      await this.lockBatch(manager, batch.batchId);
      if (await this.findBatch(batch.batchId)) return { kind: 'ALREADY_INGESTED' } as const;
      const match = matchSettlementBatch({
        provider: this.providerName,
        batch,
        deposits: await this.deposits(batch),
        settledPaymentIds: await this.alreadySettledPayments(batch),
        deductedChargebackIds: await this.alreadyDeductedChargebacks(batch),
        lookups,
        activeCurrencies: await this.activeCurrencies(),
      });
      if (match.kind === 'REJECTED') {
        return this.storeRejected(run, manager, batch, contentHash, match.code, match.discrepancy);
      }
      return this.storePosted(run, manager, batch, contentHash, match.lines);
    }).catch(async (error: unknown) => {
      if (!(error instanceof PeriodLockedError)) throw error;
      // `post()` refused the settlement date; record the refusal (nothing posted) instead.
      return this.unitOfWork.run(async (manager) => {
        await this.lockBatch(manager, batch.batchId);
        if (await this.findBatch(batch.batchId)) return { kind: 'ALREADY_INGESTED' } as const;
        return this.storeRejected(run, manager, batch, contentHash, SettlementRejection.PERIOD_LOCKED, lockedPeriodDiscrepancy(this.providerName, batch));
      });
    });

    if (outcome.kind === 'POSTED') {
      await this.checkpoints.reached(ReconciliationCheckpoint.AFTER_SETTLEMENT_COMMIT, { runId: run.id, kind: run.kind });
      for (const flowId of outcome.settledFlowIds) await this.settleFlow(flowId, outcome.transactionId);
    }
    return outcome;
  }

  /**
   * Deposits whose settlement is recorded but whose flow is still POSTED (a crash between the
   * settlement's commit and the flow transitions, or a flow that was busy): finish them.
   */
  async settlePendingFlows(): Promise<number> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT funding_payments.flow_id, settlement_batches.settlement_transaction_id
         FROM funding_payments
         JOIN flow_instances ON flow_instances.id = funding_payments.flow_id
         JOIN settlement_batch_lines ON settlement_batch_lines.id = funding_payments.settlement_batch_line_id
         JOIN settlement_batches ON settlement_batches.id = settlement_batch_lines.batch_id
        WHERE funding_payments.settled_at IS NOT NULL AND flow_instances.state = 'POSTED'
        ORDER BY funding_payments.settled_at, funding_payments.flow_id`,
    )) as { flow_id: string; settlement_transaction_id: string }[];
    let applied = 0;
    for (const row of rows) if ((await this.settleFlow(row.flow_id, row.settlement_transaction_id)) === 'APPLIED') applied += 1;
    return applied;
  }

  /** POSTED → SETTLED, through the one way a flow moves. A flow already reversed stays REVERSED. */
  private async settleFlow(flowId: string, settlementTransactionId: string): Promise<'APPLIED' | 'NOT_CLAIMED' | 'STALE'> {
    const result = await this.runner.applyExternalTransition(flowId, FundingState.POSTED, FundingState.SETTLED, async () => {
      await this.audit.record({
        actor: { type: 'SYSTEM' },
        action: AuditAction.FUNDING_STATE_CHANGED,
        subject: { type: AuditSubjectType.FLOW, id: flowId },
        before: { flowState: FundingState.POSTED },
        after: { flowState: FundingState.SETTLED, transactionId: settlementTransactionId },
        reason: `funding flow ${FundingState.POSTED} → ${FundingState.SETTLED}: paid out by the PSP's settlement`,
      });
    });
    if (result !== 'APPLIED') this.logger.warn({ flowId, result }, 'Settled deposit: flow not moved to SETTLED yet');
    return result;
  }

  private async storePosted(
    run: ClaimedRun,
    manager: EntityManager,
    batch: ProviderSettlementBatch,
    contentHash: string,
    decisions: readonly LineDecision[],
  ): Promise<IngestOutcome> {
    const posting = buildSettlementPosting(this.providerName, batch, decisions, await this.activeCurrencies());
    const posted = await this.ledger.post(posting);
    const batchRowId = await this.insertBatch(manager, batch, contentHash, 'POSTED', null, posted.transactionId);
    const lineRowIds = new Map<string, string>();
    for (const decision of decisions) {
      const { line } = decision;
      const [row] = (await manager.query(
        `INSERT INTO settlement_batch_lines
           (batch_id, provider, provider_line_id, line_type, provider_payment_id, provider_chargeback_id, amount_minor,
            fee_minor, flow_id, attribution)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          batchRowId,
          this.providerName,
          line.lineId,
          line.type,
          line.paymentId,
          line.chargebackId,
          line.amountMinor.toString(),
          line.feeMinor.toString(),
          decision.flowId,
          decision.attribution,
        ],
      )) as { id: string }[];
      lineRowIds.set(line.lineId, row.id);
    }

    const settledFlowIds: string[] = [];
    for (const decision of decisions) {
      if (decision.attribution !== 'ATTRIBUTED' || decision.line.type !== ProviderSettlementLineType.PAYMENT) continue;
      const flowId = decision.flowId as string;
      const recorded = await this.fundingPayments.recordSettlement(manager, flowId, {
        settlementBatchLineId: lineRowIds.get(decision.line.lineId) as string,
        settledAt: batch.settledAt,
        feeMinor: decision.line.feeMinor,
      });
      // The attribution was decided inside this transaction from posted, unsettled deposits;
      // the partial unique index backs it. A refusal here means our own logic is wrong.
      if (!recorded) throw new Error(`Settlement of flow ${flowId} could not be recorded: the deposit changed under the batch.`);
      settledFlowIds.push(flowId);
    }

    const detections: Detection[] = [];
    for (const decision of decisions) {
      if (!decision.discrepancy) continue;
      const detection = await this.detect(run, {
        ...decision.discrepancy,
        settlementBatchId: batchRowId,
        settlementBatchLineId: lineRowIds.get(decision.line.lineId),
      });
      // Every line discrepancy put real money into CLEARING: only a human (a Phase 10
      // CORRECTION) can move it out, whatever the break's type.
      await this.breaks.escalate(detection.breakId, RECONCILIATION_INITIATED_BY, `Settlement line ${decision.line.lineId} of ${batch.batchId} went to CLEARING.`);
      detections.push(detection);
    }
    await this.resolveUnreadableReport(batchRowId);
    await this.audit.record({
      actor: { type: 'SYSTEM' },
      action: AuditAction.SETTLEMENT_POSTED,
      subject: { type: AuditSubjectType.SETTLEMENT_BATCH, id: batchRowId },
      after: { settlementStatus: 'POSTED', transactionId: posted.transactionId },
      reason: `PSP settlement ${batch.batchId}: ${decisions.length} lines, ${detections.length} discrepancies`,
    });
    await this.checkpoints.reached(ReconciliationCheckpoint.BEFORE_COMMIT, { runId: run.id, kind: run.kind });
    this.logger.log(
      {
        runId: run.id,
        batchId: batch.batchId,
        transactionId: posted.transactionId,
        currency: batch.currency,
        grossMinor: batch.grossMinor.toString(),
        feeMinor: batch.feeMinor.toString(),
        chargebackMinor: batch.chargebackMinor.toString(),
        netMinor: batch.netMinor.toString(),
        lines: decisions.length,
        discrepancies: detections.length,
        initiatedBy: RECONCILIATION_INITIATED_BY,
      },
      'Settlement posted',
    );
    return { kind: 'POSTED', batchRowId, transactionId: posted.transactionId, settledFlowIds, detections };
  }

  private async storeRejected(
    run: ClaimedRun,
    manager: EntityManager,
    batch: ProviderSettlementBatch,
    contentHash: string,
    code: SettlementRejection,
    discrepancy: DetectedDiscrepancy | null,
  ): Promise<IngestOutcome> {
    const batchRowId = await this.insertBatch(manager, batch, contentHash, 'REJECTED', code, null);
    const detections = discrepancy ? [await this.detect(run, { ...discrepancy, settlementBatchId: batchRowId })] : [];
    await this.audit.record({
      actor: { type: 'SYSTEM' },
      action: AuditAction.SETTLEMENT_REJECTED,
      subject: { type: AuditSubjectType.SETTLEMENT_BATCH, id: batchRowId },
      after: { settlementStatus: 'REJECTED', rejectionCode: code },
      reason: `PSP settlement ${batch.batchId} refused (${code}); nothing posted`,
    });
    await this.checkpoints.reached(ReconciliationCheckpoint.BEFORE_COMMIT, { runId: run.id, kind: run.kind });
    this.logger.error({ runId: run.id, batchId: batch.batchId, rejection: code, netMinor: batch.netMinor.toString() }, 'Settlement report refused');
    return { kind: 'REJECTED', batchRowId, code, detections };
  }

  private async recordChangedReport(run: ClaimedRun, batch: ProviderSettlementBatch, batchRowId: string, contentHash: string): Promise<IngestOutcome> {
    const detection = await this.unitOfWork.run(async (manager) => {
      await manager.query(
        `INSERT INTO settlement_report_versions (batch_id, content_hash, provider_call_ids)
         VALUES ($1, $2, $3::bigint[]) ON CONFLICT (batch_id, content_hash) DO NOTHING`,
        [batchRowId, contentHash, batch.providerCallIds],
      );
      return this.detect(run, {
        type: BreakType.SETTLEMENT_BATCH_CHANGED,
        subjectKey: subjectKeys.batch(this.providerName, batch.batchId),
        currency: batch.currency,
        amountMinor: batch.netMinor < 0n ? -batch.netMinor : batch.netMinor,
        settlementBatchId: batchRowId,
        details: { batchId: batch.batchId, contentHash, netMinor: batch.netMinor.toString(), lineCount: batch.lineCount },
      });
    });
    this.logger.error({ runId: run.id, batchId: batch.batchId, contentHash }, 'Settlement report changed after it was ingested');
    return { kind: 'CHANGED', detections: [detection] };
  }

  /** A report that failed to parse earlier and has now been ingested: that break has a cause. */
  private async resolveUnreadableReport(batchRowId: string): Promise<void> {
    const [row] = (await this.unitOfWork.manager.query(`SELECT provider_batch_id FROM settlement_batches WHERE id = $1`, [batchRowId])) as {
      provider_batch_id: string;
    }[];
    const live = await this.breaks.findLive(BreakType.SETTLEMENT_REPORT_REJECTED, subjectKeys.batch(this.providerName, row.provider_batch_id));
    if (live && live.details.rejection === 'UNREADABLE') {
      await this.breaks.resolve(live.id, RECONCILIATION_INITIATED_BY, ResolutionKind.REPORT_INGESTED, batchRowId, 'the report was read and ingested');
    }
  }

  private detect(run: ClaimedRun, candidate: BreakCandidate): Promise<Detection> {
    return this.breaks.detectAndRecord(run.id, candidate);
  }

  private async insertBatch(
    manager: EntityManager,
    batch: ProviderSettlementBatch,
    contentHash: string,
    status: 'POSTED' | 'REJECTED',
    rejectionCode: SettlementRejection | null,
    transactionId: string | null,
  ): Promise<string> {
    const [row] = (await manager.query(
      `INSERT INTO settlement_batches
         (provider, provider_batch_id, currency_code, settled_at, gross_minor, fee_minor, chargeback_minor, net_minor,
          line_count, content_hash, status, rejection_code, settlement_transaction_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        this.providerName,
        batch.batchId,
        batch.currency,
        batch.settledAt,
        batch.grossMinor.toString(),
        batch.feeMinor.toString(),
        batch.chargebackMinor.toString(),
        batch.netMinor.toString(),
        batch.lineCount,
        contentHash,
        status,
        rejectionCode,
        transactionId,
      ],
    )) as { id: string }[];
    await manager.query(
      `INSERT INTO settlement_report_versions (batch_id, content_hash, provider_call_ids) VALUES ($1, $2, $3::bigint[])`,
      [row.id, contentHash, batch.providerCallIds],
    );
    return row.id;
  }

  private async findBatch(batchId: string): Promise<{ id: string; contentHash: string } | null> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT id, content_hash FROM settlement_batches WHERE provider = $1 AND provider_batch_id = $2`,
      [this.providerName, batchId],
    )) as { id: string; content_hash: string }[];
    return row ? { id: row.id, contentHash: row.content_hash } : null;
  }

  /** Serialise the ingestion of ONE batch across workers (the unique keys are the backstop). */
  private async lockBatch(manager: EntityManager, batchId: string): Promise<void> {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`settlement:${this.providerName}:${batchId}`]);
  }

  private async deposits(batch: ProviderSettlementBatch): Promise<Map<string, KnownDeposit>> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT flow_id, provider_payment_id, currency_code, amount_minor::text AS amount_minor,
              funding_transaction_id IS NOT NULL AS posted
         FROM funding_payments WHERE provider = $1 AND provider_payment_id = ANY($2::text[])`,
      [this.providerName, [...new Set(batch.lines.map((line) => line.paymentId))]],
    )) as { flow_id: string; provider_payment_id: string; currency_code: string; amount_minor: string; posted: boolean }[];
    return new Map(
      rows.map((row) => [
        row.provider_payment_id,
        { flowId: row.flow_id, providerPaymentId: row.provider_payment_id, currency: row.currency_code, amountMinor: BigInt(row.amount_minor), posted: row.posted },
      ]),
    );
  }

  private async alreadySettledPayments(batch: ProviderSettlementBatch): Promise<Set<string>> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT provider_payment_id FROM settlement_batch_lines
        WHERE provider = $1 AND line_type = 'PAYMENT' AND attribution = 'ATTRIBUTED' AND provider_payment_id = ANY($2::text[])`,
      [this.providerName, batch.lines.map((line) => line.paymentId)],
    )) as { provider_payment_id: string }[];
    return new Set(rows.map((row) => row.provider_payment_id));
  }

  private async alreadyDeductedChargebacks(batch: ProviderSettlementBatch): Promise<Set<string>> {
    const ids = batch.lines.flatMap((line) => (line.chargebackId ? [line.chargebackId] : []));
    const rows = (await this.unitOfWork.manager.query(
      `SELECT provider_chargeback_id FROM settlement_batch_lines
        WHERE provider = $1 AND line_type = 'CHARGEBACK' AND attribution = 'ATTRIBUTED' AND provider_chargeback_id = ANY($2::text[])`,
      [this.providerName, ids],
    )) as { provider_chargeback_id: string }[];
    return new Set(rows.map((row) => row.provider_chargeback_id));
  }

  private async activeCurrencies(): Promise<Set<string>> {
    const rows = (await this.unitOfWork.manager.query(`SELECT code FROM currencies WHERE is_active`)) as { code: string }[];
    return new Set(rows.map((row) => row.code));
  }

  /** Lines naming a deposit of ours that is not in the ledger yet: drive its flow first. */
  private async driveUnbookedDeposits(batch: ProviderSettlementBatch): Promise<void> {
    const deposits = await this.deposits(batch);
    for (const deposit of deposits.values()) {
      if (!deposit.posted) await this.runner.advance(deposit.flowId);
    }
  }

  /**
   * For every payment id no deposit of ours carries: ask the PSP. A payment under one of OUR flow
   * ids (the authorization answer was lost before we recorded the id) is driven — the flow adopts
   * it; one under a reference that is no flow of ours is FOREIGN; a 404 is UNKNOWN.
   */
  private async lookUpUnknownPayments(batch: ProviderSettlementBatch): Promise<Map<string, PaymentLookup>> {
    const known = await this.deposits(batch);
    const lookups = new Map<string, PaymentLookup>();
    for (const paymentId of new Set(batch.lines.map((line) => line.paymentId))) {
      if (known.has(paymentId)) continue;
      const payment = await this.provider.findPayment(paymentId, {});
      if (!payment) {
        lookups.set(paymentId, { kind: 'UNKNOWN' });
        continue;
      }
      if (UUID.test(payment.reference) && (await this.fundingPayments.findByFlowId(payment.reference))) {
        await this.runner.advance(payment.reference);
        continue; // now a known deposit (or still not ours to attribute: then UNKNOWN below)
      }
      lookups.set(paymentId, { kind: 'FOREIGN', reference: payment.reference });
    }
    return lookups;
  }
}
