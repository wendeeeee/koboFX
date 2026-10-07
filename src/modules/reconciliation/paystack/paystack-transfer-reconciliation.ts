import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import { InvariantViolationError } from '../../../common/errors';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { FlowRunner } from '../../flows/flow-runner';
import { PaystackWithdrawalState } from '../../flows/paystack-withdrawal/paystack-withdrawal-transitions';
import { PaystackTransferWebhookResolver } from '../../payments/paystack/transfers/paystack-transfer-webhook-resolver';
import {
  PaystackTransferCallFailedError,
  PaystackTransfersGateway,
  TransferObservation,
  TransferStatusClassification,
} from '../../payments/paystack/transfers/paystack-transfers.port';
import { eventTypeOf, familyOfEvent, PaystackEventFamily } from '../../payments/paystack/webhooks/paystack-event-family';
import { STORED_PAYLOAD_COLUMNS, StoredWebhookPayloadReader, StoredWebhookPayloadRow } from '../../payments/webhooks/stored-webhook-payload';
import { ProtectedEvidenceService } from '../../protection/protected-evidence.service';
import { WithdrawalFlow } from '../../withdrawals/withdrawal-flow';
import { WithdrawalTrigger } from '../../withdrawals/withdrawal-trigger-context';
import { BreakType, subjectKeys } from '../break-types';
import { ResolutionKind } from '../break-transitions';
import { BreakService } from '../break.service';
import { RECONCILIATION_INITIATED_BY } from '../settlement-posting';
import { ComponentRun, PaystackReconciliationComponent, PaystackReconciliationFamily } from './paystack-reconciliation-run';
import { PaystackReconciliationComposer } from './paystack-reconciliation.composer';

const DAY = 24 * 3600 * 1000;
const PROVIDER = 'paystack';
/** A page cap is an INCOMPLETE scan, never "no more transfers" (§B). */
export const MAXIMUM_TRANSFER_PAGES = 1_000;
const KEYSET_PAGE = 200;
/** The historical census walks from inception in windows of this size, at most this many per daily run. */
export const CENSUS_WINDOW_DAYS = 7;
export const CENSUS_WINDOWS_PER_RUN = 12;
export const CENSUS_COMPONENT = 'transfer-census';
/**
 * The hourly keyset over unresolved payout flows of any age (`flow_instances_unresolved_payout_index`). Exported so
 * the plan suite EXPLAINs the exact statement. `$1, $2` = the last `(created_at, id)` seen, or nulls.
 */
export const UNRESOLVED_PAYOUT_FLOWS_PAGE = `SELECT flow_instances.id, flow_instances.created_at
           FROM flow_instances
          WHERE flow_instances.completed_at IS NULL AND flow_instances.flow_type IN ('PAYSTACK_WITHDRAWAL', 'PAYSTACK_BENEFICIARY')
            AND ($1::timestamptz IS NULL OR (flow_instances.created_at, flow_instances.id) > ($1::timestamptz, $2::uuid))
          ORDER BY flow_instances.created_at, flow_instances.id
          LIMIT ${KEYSET_PAGE}`;

/** The daily keyset over posted, not-reversed withdrawals of any age (`paystack_withdrawals_posted_unreversed_index`). */
export const POSTED_UNREVERSED_PAGE = `SELECT flow_id, posted_at, provider_reference, currency_code, principal_minor::text AS principal_minor
           FROM paystack_withdrawals
          WHERE posted_at IS NOT NULL AND reversed_at IS NULL
            AND ($1::timestamptz IS NULL OR (posted_at, flow_id) > ($1::timestamptz, $2::uuid))
          ORDER BY posted_at, flow_id
          LIMIT ${KEYSET_PAGE}`;
const UNRESOLVED_STATES: readonly string[] = [PaystackWithdrawalState.RESERVED, PaystackWithdrawalState.SUBMITTING, PaystackWithdrawalState.PROCESSING];

interface Intent {
  readonly flowId: string;
  readonly state: string;
}

interface Counts {
  [name: string]: number;
}

/**
 * Withdrawals' share of the composed Paystack run (WITHDRAWAL_PLAN.md §I.2): the TRANSFER family. Matching is on
 * Paystack's transfer id / code and OUR reference only; every authoritative read it acts on is kept as sealed evidence
 * + an observation with this run's provenance (source RECONCILIATION, `reconciliation_run_id`).
 *
 * Hourly — drive EVERY unresolved withdrawal and beneficiary of any age (keyset over `(created_at, id)`: the oldest
 * page can never starve later rows) through `FlowRunner.advance`; a withdrawal still unresolved past
 * `RECONCILIATION_UNRESOLVED_FLOW_AGE_MINUTES` is a WITHDRAWAL_NOT_POSTED break (investigate: provider lag first).
 *
 * Daily —
 * 1. transfer census over the moving window (overlapping, paginated, deduped): a successful transfer no intent explains
 *    → TRANSFER_WITHOUT_INTENT; one of ours whose identity differs → TRANSFER_IDENTITY_MISMATCH; a FAILED intent whose
 *    transfer succeeded → a late success: a matching verify observation is recorded on the withdrawal and its id goes
 *    in the break (MONEY, recovered only by an approved PAYSTACK_WITHDRAWAL_RECOVERY).
 * 2. the historical census from inception, resumable on a durable watermark (`reconciliation_component_progress`).
 * 3. every POSTED-not-reversed withdrawal, whatever its age: Paystack says reversed ⇒ drive the flow; still not
 *    REVERSED ⇒ WITHDRAWAL_RETURN_NOT_POSTED. (The late reversal outside any lookback.)
 * 4. unmatched TRANSFER-family webhooks (sealed payloads) reprocessed.
 * 5. internal proofs in ONE `REPEATABLE READ READ ONLY` snapshot (receipts ⇔ postings ⇔ state; protected holds;
 *    in-transit nets to zero; payout balance ≥ 0 or the D3 treasury break; fee evidence; stash nets).
 * 6. balance evidence: `/balance` and `/balance/ledger` kept (no break for unattributed rows: D3).
 *
 * An incomplete scan (page cap) is pushed to `seen.incomplete`: the composer then neither sweeps nor finishes.
 */
@Injectable()
export class PaystackTransferReconciliation implements PaystackReconciliationComponent, OnModuleInit {
  readonly family = PaystackReconciliationFamily.TRANSFER;
  /** The page cap per scan (a test seam: tests lower it to reach the cap without a thousand pages). */
  maximumPages = MAXIMUM_TRANSFER_PAGES;
  private readonly logger = new Logger(PaystackTransferReconciliation.name);

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly gateway: PaystackTransfersGateway,
    private readonly runner: FlowRunner,
    private readonly withdrawals: WithdrawalFlow,
    private readonly breaks: BreakService,
    private readonly composer: PaystackReconciliationComposer,
    private readonly evidence: ProtectedEvidenceService,
    private readonly payloads: StoredWebhookPayloadReader,
    private readonly resolver: PaystackTransferWebhookResolver,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.composer.addComponent(this);
  }

  async runHourly(context: ComponentRun): Promise<Counts | null> {
    if (!(await this.configured(context))) return null;
    const counts: Counts = { unresolvedFlowsDriven: 0, driveFailures: 0 };
    await this.driveUnresolved(context, counts);
    await this.retryAutomaticResolutions(context);
    return counts;
  }

  async runDaily(context: ComponentRun): Promise<Counts | null> {
    if (!(await this.configured(context))) return null;
    const counts: Counts = { transfersListed: 0, historicalWindowsScanned: 0, postedWithdrawalsChecked: 0, unmatchedWebhooksReprocessed: 0, balanceLedgerRows: 0 };
    const now = this.clock.now();
    const windowStart = new Date(now.getTime() - this.config.reconciliation.lookbackDays * DAY);
    const listed = new Set<string>();
    // The moving window overlaps by a day on each side: a transfer created at the edge is never missed.
    await this.census(context, new Date(windowStart.getTime() - DAY), new Date(now.getTime() + DAY), 'TRANSFER_LIST', listed, counts);
    await context.heartbeat();
    await this.historicalCensus(context, windowStart, listed, counts);
    await context.heartbeat();
    await this.revisitPosted(context, counts);
    await context.heartbeat();
    await this.reprocessUnmatchedWebhooks(context, counts);
    await this.proveInternally(context);
    await this.keepBalanceEvidence(context, windowStart, now, counts);
    await this.retryAutomaticResolutions(context);
    return counts;
  }

  /**
   * The family runs when it can record evidence: the account identity and the key rings. Without them, recorded
   * withdrawal work is an incomplete run (fail loudly: never "clean" while payouts go unreconciled); with no work the
   * family simply did not run (and proves nothing).
   */
  private async configured(context: ComponentRun): Promise<boolean> {
    if (this.config.withdrawals.accountIdentity && this.config.protection.keyEncryption && this.config.protection.fingerprint) return true;
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT count(*)::int AS count FROM flow_instances WHERE flow_type IN ('PAYSTACK_WITHDRAWAL', 'PAYSTACK_BENEFICIARY')`,
    )) as { count: number }[];
    if (row.count > 0) context.seen.incomplete.push('TRANSFER family: PAYSTACK_ACCOUNT_IDENTITY or the key rings are not configured');
    return false;
  }

  // ── hourly: every unresolved flow, any age ──

  private async driveUnresolved(context: ComponentRun, counts: Counts): Promise<void> {
    const cutoff = new Date(this.clock.now().getTime() - this.config.reconciliation.unresolvedFlowAgeMinutes * 60_000);
    let after: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const page = (await this.unitOfWork.manager.query(
        UNRESOLVED_PAYOUT_FLOWS_PAGE,
        [after?.createdAt ?? null, after?.id ?? null],
      )) as { id: string; created_at: Date }[];
      if (page.length === 0) break;
      for (const row of page) {
        await this.drive(context, row.id, false, counts);
        counts.unresolvedFlowsDriven += 1;
        await this.detectNotPosted(context, row.id, cutoff);
      }
      after = { createdAt: page[page.length - 1].created_at, id: page[page.length - 1].id };
      await context.heartbeat();
    }
  }

  private async detectNotPosted(context: ComponentRun, flowId: string, cutoff: Date): Promise<void> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT flow_instances.state, flow_instances.created_at, paystack_withdrawals.currency_code, paystack_withdrawals.principal_minor::text AS principal_minor,
              review.reason::text AS review_reason
         FROM flow_instances JOIN paystack_withdrawals ON paystack_withdrawals.flow_id = flow_instances.id
         LEFT JOIN withdrawal_review_events review ON review.id = paystack_withdrawals.current_review_event_id AND review.event_kind <> 'RESOLVED'
        WHERE flow_instances.id = $1 AND flow_instances.completed_at IS NULL`,
      [flowId],
    )) as { state: string; created_at: Date; currency_code: string; principal_minor: string; review_reason: string | null }[];
    if (!row || row.created_at.getTime() >= cutoff.getTime()) return;
    await context.detect({
      type: BreakType.WITHDRAWAL_NOT_POSTED,
      subjectKey: subjectKeys.withdrawal(flowId),
      currency: row.currency_code,
      amountMinor: BigInt(row.principal_minor),
      flowId,
      details: { withdrawalId: flowId, flowState: row.state, reviewReason: row.review_reason, createdAt: row.created_at.toISOString() },
    });
  }

  // ── daily 1–2: the transfer census ──

  /** One paginated scan of `[from, to)`. Returns false when it hit the page cap (the window is NOT covered). */
  private async census(context: ComponentRun, from: Date, to: Date, source: string, listed: Set<string>, counts: Counts): Promise<boolean> {
    let page: string | undefined;
    for (let pages = 0; pages < this.maximumPages; pages += 1) {
      const result = await this.gateway.listTransfers({ from, to, ...(page ? { page } : {}) });
      for (const transfer of result.value.items) {
        const key = transfer.transferId ?? (transfer.reference ? `reference:${transfer.reference}` : null);
        if (key === null || listed.has(key)) continue; // pages shift under us; windows overlap
        listed.add(key);
        counts.transfersListed += 1;
        await this.checkTransfer(context, transfer, source, counts);
      }
      if (!result.value.nextCursor) return true;
      page = result.value.nextCursor;
    }
    context.seen.incomplete.push(`transfer census ${from.toISOString()}..${to.toISOString()} hit the ${this.maximumPages}-page cap`);
    return false;
  }

  private async checkTransfer(context: ComponentRun, listed: TransferObservation, source: string, counts: Counts): Promise<void> {
    const intents = await this.intentsFor(listed);
    if (intents.length > 1) {
      await this.identityMismatch(context, listed, null, { reason: 'IDENTIFIERS_NAME_SEVERAL_WITHDRAWALS', withdrawalIds: intents.map((intent) => intent.flowId) }, source);
      return;
    }
    const [intent] = intents;
    if (!intent) {
      await this.transferWithoutIntent(context, listed, source);
      return;
    }
    if (intent.state === PaystackWithdrawalState.RESERVED) {
      // A transfer under our reference before our submission marker: an authorization break, never a completion.
      await this.identityMismatch(context, listed, intent.flowId, { reason: 'TRANSFER_BEFORE_SUBMISSION_MARKER' }, source);
      return;
    }
    const record = await this.withdrawals.load(intent.flowId);
    const fingerprint = await this.withdrawals.recipientFingerprint(record, listed);
    if (!this.withdrawals.matches(record, listed, fingerprint)) {
      // The list may be a stale or partial rendering: decide on an authoritative verify, kept as evidence.
      const observed = await this.observe(context, intent.flowId);
      if (!observed || !observed.matches) {
        await this.identityMismatch(context, observed?.observation ?? listed, intent.flowId, { reason: 'IDENTITY_DIFFERS', observationId: observed?.observationId ?? null }, source);
        return;
      }
    }
    if (UNRESOLVED_STATES.includes(intent.state)) {
      await this.drive(context, intent.flowId, false, counts);
      return;
    }
    if (intent.state === PaystackWithdrawalState.FAILED && listed.classification === TransferStatusClassification.SUCCESS) {
      await this.lateSuccess(context, intent.flowId, source);
    }
  }

  /** A FAILED withdrawal whose transfer succeeded: verify, keep the observation, raise the MONEY break naming it. */
  private async lateSuccess(context: ComponentRun, flowId: string, source: string): Promise<void> {
    const observed = await this.observe(context, flowId);
    if (!observed || observed.observation.classification !== TransferStatusClassification.SUCCESS) return; // the list was stale
    if (!observed.matches) {
      await this.identityMismatch(context, observed.observation, flowId, { reason: 'IDENTITY_DIFFERS', observationId: observed.observationId }, source);
      return;
    }
    const transfer = observed.observation;
    await context.detect({
      type: BreakType.TRANSFER_WITHOUT_INTENT,
      subjectKey: subjectKeys.transfer(PROVIDER, transfer.transferId ?? `reference:${transfer.reference}`),
      currency: transfer.currency,
      amountMinor: transfer.amountMinor ?? 0n,
      flowId,
      details: {
        lateSuccess: true,
        failedWithdrawalId: flowId,
        observationId: observed.observationId,
        transferId: transfer.transferId,
        reference: transfer.reference,
        paystackStatus: transfer.rawStatus,
        amountMinor: transfer.amountMinor?.toString() ?? null,
        source,
      },
    });
  }

  private async transferWithoutIntent(context: ComponentRun, listed: TransferObservation, source: string): Promise<void> {
    if (listed.classification !== TransferStatusClassification.SUCCESS) return;
    // Verify the candidate before acting: an authoritative read, never the list alone.
    const confirmed = await this.confirm(listed);
    if (!confirmed || confirmed.classification !== TransferStatusClassification.SUCCESS) return;
    await context.detect({
      type: BreakType.TRANSFER_WITHOUT_INTENT,
      subjectKey: subjectKeys.transfer(PROVIDER, confirmed.transferId ?? `reference:${confirmed.reference}`),
      currency: confirmed.currency,
      amountMinor: confirmed.amountMinor ?? 0n,
      details: {
        lateSuccess: false,
        transferId: confirmed.transferId,
        transferCode: confirmed.transferCode,
        reference: confirmed.reference,
        paystackStatus: confirmed.rawStatus,
        amountMinor: confirmed.amountMinor?.toString() ?? null,
        currency: confirmed.currency,
        domain: confirmed.domain,
        source,
      },
    });
  }

  private async identityMismatch(
    context: ComponentRun,
    transfer: TransferObservation,
    flowId: string | null,
    why: Record<string, unknown>,
    source: string,
  ): Promise<void> {
    await context.detect({
      type: BreakType.TRANSFER_IDENTITY_MISMATCH,
      subjectKey: subjectKeys.transfer(PROVIDER, transfer.transferId ?? `reference:${transfer.reference}`),
      currency: transfer.currency,
      amountMinor: transfer.amountMinor ?? 0n,
      ...(flowId ? { flowId } : {}),
      details: {
        ...why,
        withdrawalId: flowId,
        transferId: transfer.transferId,
        reference: transfer.reference,
        paystackStatus: transfer.rawStatus,
        amountMinor: transfer.amountMinor?.toString() ?? null,
        currency: transfer.currency,
        domain: transfer.domain,
        source,
      },
    });
  }

  /** The durable historical census: windows from inception up to the moving window, resumed where the last run stopped. */
  private async historicalCensus(context: ComponentRun, windowStart: Date, listed: Set<string>, counts: Counts): Promise<void> {
    const progress = await this.progress(context, windowStart);
    // Nothing is older than the moving window yet: the moving census covers everything.
    if (progress.origin.getTime() >= windowStart.getTime()) return;
    let watermark = progress.watermark;
    for (let windows = 0; windows < CENSUS_WINDOWS_PER_RUN; windows += 1) {
      if (watermark.getTime() >= windowStart.getTime()) {
        // A full cycle from inception is covered: the next run starts the next one (every partition is visited again).
        await this.unitOfWork.manager.query(
          `UPDATE reconciliation_component_progress
              SET watermark = origin, cycles = cycles + 1, last_cycle_completed_at = now(), last_run_id = $3, updated_at = now()
            WHERE provider = $1 AND component = $2`,
          [PROVIDER, CENSUS_COMPONENT, context.run.id],
        );
        return;
      }
      const end = new Date(Math.min(watermark.getTime() + CENSUS_WINDOW_DAYS * DAY, windowStart.getTime()));
      if (!(await this.census(context, watermark, end, 'HISTORICAL_CENSUS', listed, counts))) return; // never advance past an unread page
      await this.unitOfWork.manager.query(
        `UPDATE reconciliation_component_progress SET watermark = $3, last_run_id = $4, updated_at = now() WHERE provider = $1 AND component = $2`,
        [PROVIDER, CENSUS_COMPONENT, end, context.run.id],
      );
      counts.historicalWindowsScanned += 1;
      watermark = end;
      await context.heartbeat();
    }
  }

  /** The census progress row; created once, its origin the earliest recorded payout work (or the window) less a day. */
  private async progress(context: ComponentRun, windowStart: Date): Promise<{ origin: Date; watermark: Date }> {
    await this.unitOfWork.manager.query(
      `INSERT INTO reconciliation_component_progress (provider, component, origin, watermark, last_run_id)
       SELECT $1, $2, origin, origin, $4
         FROM (SELECT least($3::timestamptz,
                            coalesce((SELECT min(created_at) FROM flow_instances WHERE flow_type IN ('PAYSTACK_WITHDRAWAL', 'PAYSTACK_BENEFICIARY')), $3::timestamptz))
                      - interval '1 day' AS origin) AS inception
       ON CONFLICT (provider, component) DO NOTHING`,
      [PROVIDER, CENSUS_COMPONENT, windowStart, context.run.id],
    );
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT origin, watermark FROM reconciliation_component_progress WHERE provider = $1 AND component = $2`,
      [PROVIDER, CENSUS_COMPONENT],
    )) as { origin: Date; watermark: Date }[];
    return row;
  }

  // ── daily 3: posted withdrawals, whatever their age ──

  private async revisitPosted(context: ComponentRun, counts: Counts): Promise<void> {
    let after: { postedAt: Date; flowId: string } | null = null;
    for (;;) {
      const page = (await this.unitOfWork.manager.query(
        POSTED_UNREVERSED_PAGE,
        [after?.postedAt ?? null, after?.flowId ?? null],
      )) as { flow_id: string; posted_at: Date; provider_reference: string; currency_code: string; principal_minor: string }[];
      if (page.length === 0) return;
      for (const row of page) {
        counts.postedWithdrawalsChecked += 1;
        const verified = await this.gateway.verifyTransfer(row.provider_reference, { flowId: row.flow_id });
        if (!verified.found || verified.observation.classification !== TransferStatusClassification.REVERSED) continue;
        await this.drive(context, row.flow_id, true, counts);
        const [after] = (await this.unitOfWork.manager.query(`SELECT state FROM flow_instances WHERE id = $1`, [row.flow_id])) as { state: string }[];
        if (after.state === PaystackWithdrawalState.REVERSED) continue;
        await context.detect({
          type: BreakType.WITHDRAWAL_RETURN_NOT_POSTED,
          subjectKey: subjectKeys.withdrawal(row.flow_id),
          currency: row.currency_code,
          amountMinor: BigInt(row.principal_minor),
          flowId: row.flow_id,
          details: {
            withdrawalId: row.flow_id,
            paystackStatus: verified.observation.rawStatus,
            transferId: verified.observation.transferId,
            postedAt: row.posted_at.toISOString(),
            flowState: after.state,
          },
        });
      }
      after = { postedAt: page[page.length - 1].posted_at, flowId: page[page.length - 1].flow_id };
      await context.heartbeat();
    }
  }

  // ── daily 4: unmatched TRANSFER-family webhooks ──

  private async reprocessUnmatchedWebhooks(context: ComponentRun, counts: Counts): Promise<void> {
    const events = (await this.unitOfWork.manager.query(
      `SELECT webhook_events.id, ${STORED_PAYLOAD_COLUMNS}
         FROM webhook_events
        WHERE webhook_events.outcome = 'UNMATCHED' AND webhook_events.provider = $1 AND webhook_events.payload_encoding = 'SEALED_V1'
          AND NOT EXISTS (SELECT 1 FROM reconciliation_breaks
                           WHERE reconciliation_breaks.type = 'UNMATCHED_WEBHOOK'
                             AND reconciliation_breaks.webhook_event_id = webhook_events.id
                             AND reconciliation_breaks.status <> 'OPEN')
        ORDER BY webhook_events.received_at, webhook_events.id
        LIMIT 500`,
      [PROVIDER],
    )) as StoredWebhookPayloadRow[];
    for (const event of events) {
      const payload = await this.payloads.read(event);
      const eventType = eventTypeOf(payload);
      // Only the TRANSFER family is ours: a charge event is funding's, an unknown family nobody's to guess.
      if (eventType === null || familyOfEvent(eventType) !== PaystackEventFamily.TRANSFER) continue;
      counts.unmatchedWebhooksReprocessed += 1;
      const breakId = await context.detect({
        type: BreakType.UNMATCHED_WEBHOOK,
        subjectKey: subjectKeys.webhook(event.id),
        currency: null,
        amountMinor: 0n,
        webhookEventId: event.id,
        details: { webhookEventId: event.id, provider: PROVIDER, family: PaystackReconciliationFamily.TRANSFER, eventType },
      });
      const resolved = await this.resolver.resolve(payload, eventType);
      if (resolved.flowId) {
        await this.drive(context, resolved.flowId, true, counts);
        await this.breaks.resolve(breakId, RECONCILIATION_INITIATED_BY, ResolutionKind.WEBHOOK_REPROCESSED, resolved.flowId, 'stored payload reprocessed: matches a withdrawal');
        context.seen.resolved.add(breakId);
        continue;
      }
      const why = resolved.conflict
        ? `its identifiers conflict (${resolved.conflict})`
        : 'it names no withdrawal of ours (a successful transfer has its own TRANSFER_WITHOUT_INTENT break)';
      await this.breaks.escalate(breakId, RECONCILIATION_INITIATED_BY, `Unmatched Paystack transfer webhook reprocessed: ${why}.`);
    }
  }

  // ── daily 5: internal proofs, one snapshot ──

  private async proveInternally(context: ComponentRun): Promise<void> {
    const findings = await this.unitOfWork.runReadOnlySnapshot(
      async (manager) => {
        const receipts = (await manager.query(
          `SELECT w.flow_id, f.state, w.currency_code, w.principal_minor::text AS principal_minor,
                  count(r.id) FILTER (WHERE r.event_kind = 'CONFIRMATION')::int AS confirmations,
                  count(r.id) FILTER (WHERE r.event_kind = 'REVERSAL')::int AS reversals,
                  coalesce(bool_and(r.ledger_transaction_id = CASE r.event_kind WHEN 'CONFIRMATION' THEN w.principal_transaction_id
                                                                                ELSE w.reversal_transaction_id END), TRUE) AS linked,
                  (w.posted_at IS NULL OR EXISTS (
                     SELECT 1 FROM ledger_entries e WHERE e.transaction_id = w.principal_transaction_id AND e.account_id = w.account_id
                        AND e.direction = 'DEBIT' AND e.amount_minor = w.principal_minor)) AS principal_posted,
                  (w.reversed_at IS NULL OR EXISTS (
                     SELECT 1 FROM ledger_entries e WHERE e.transaction_id = w.reversal_transaction_id AND e.account_id = w.account_id
                        AND e.direction = 'CREDIT' AND e.amount_minor = w.principal_minor)) AS reversal_posted
             FROM paystack_withdrawals w JOIN flow_instances f ON f.id = w.flow_id
             LEFT JOIN stash_receipts r ON r.withdrawal_id = w.flow_id
            GROUP BY w.flow_id, f.state
           HAVING NOT (
                    (f.state = 'POSTED' AND count(r.id) FILTER (WHERE r.event_kind = 'CONFIRMATION') = 1
                                        AND count(r.id) FILTER (WHERE r.event_kind = 'REVERSAL') = 0)
                 OR (f.state = 'REVERSED' AND count(r.id) FILTER (WHERE r.event_kind = 'CONFIRMATION') = 1
                                          AND count(r.id) FILTER (WHERE r.event_kind = 'REVERSAL') = 1)
                 OR (f.state NOT IN ('POSTED', 'REVERSED') AND count(r.id) = 0))
               OR NOT coalesce(bool_and(r.ledger_transaction_id = CASE r.event_kind WHEN 'CONFIRMATION' THEN w.principal_transaction_id
                                                                                    ELSE w.reversal_transaction_id END), TRUE)
               OR NOT (w.posted_at IS NULL OR EXISTS (
                     SELECT 1 FROM ledger_entries e WHERE e.transaction_id = w.principal_transaction_id AND e.account_id = w.account_id
                        AND e.direction = 'DEBIT' AND e.amount_minor = w.principal_minor))
               OR NOT (w.reversed_at IS NULL OR EXISTS (
                     SELECT 1 FROM ledger_entries e WHERE e.transaction_id = w.reversal_transaction_id AND e.account_id = w.account_id
                        AND e.direction = 'CREDIT' AND e.amount_minor = w.principal_minor))
            ORDER BY w.flow_id`,
        )) as {
          flow_id: string;
          state: string;
          currency_code: string;
          principal_minor: string;
          confirmations: number;
          reversals: number;
          linked: boolean;
          principal_posted: boolean;
          reversal_posted: boolean;
        }[];
        const nets = (await manager.query(
          `WITH receipted AS (
             SELECT user_id, currency_code,
                    sum(CASE event_kind WHEN 'CONFIRMATION' THEN amount_minor ELSE -amount_minor END) AS minor
               FROM stash_receipts GROUP BY user_id, currency_code
           ), principal AS (
             SELECT user_id, currency_code,
                    sum(CASE WHEN posted_at IS NOT NULL THEN principal_minor ELSE 0 END)
                      - sum(CASE WHEN reversed_at IS NOT NULL THEN principal_minor ELSE 0 END) AS minor
               FROM paystack_withdrawals GROUP BY user_id, currency_code
           )
           SELECT coalesce(receipted.user_id, principal.user_id) AS user_id,
                  coalesce(receipted.currency_code, principal.currency_code) AS currency_code,
                  coalesce(receipted.minor, 0)::text AS receipted_minor, coalesce(principal.minor, 0)::text AS principal_minor
             FROM receipted FULL JOIN principal ON principal.user_id = receipted.user_id AND principal.currency_code = receipted.currency_code
            WHERE coalesce(receipted.minor, 0) <> coalesce(principal.minor, 0)
            ORDER BY 1, 2`,
        )) as { user_id: string; currency_code: string; receipted_minor: string; principal_minor: string }[];
        const holds = (await manager.query(
          `SELECT reservations.id, reservations.flow_id, reservations.amount_minor::text AS amount_minor, accounts.currency_code,
                  flow_instances.state, flow_instances.completed_at IS NOT NULL AS completed, paystack_withdrawals.flow_id IS NOT NULL AS linked
             FROM reservations
             JOIN accounts ON accounts.id = reservations.account_id
             LEFT JOIN flow_instances ON flow_instances.id = reservations.flow_id
             LEFT JOIN paystack_withdrawals ON paystack_withdrawals.reservation_id = reservations.id
            WHERE reservations.status = 'ACTIVE' AND reservations.expiry_policy = 'FLOW_CONTROLLED'
              AND (flow_instances.id IS NULL OR flow_instances.completed_at IS NOT NULL
                   OR flow_instances.state NOT IN ('RESERVED', 'SUBMITTING', 'PROCESSING') OR paystack_withdrawals.flow_id IS NULL)
            ORDER BY reservations.id`,
        )) as { id: string; flow_id: string; amount_minor: string; currency_code: string; state: string | null; completed: boolean | null; linked: boolean }[];
        const payout = (await manager.query(
          `SELECT currency_code,
                  coalesce(sum(balance_minor) FILTER (WHERE code LIKE 'PAYSTACK_PAYOUT_IN_TRANSIT:%'), 0)::text AS in_transit_minor,
                  coalesce(sum(balance_minor) FILTER (WHERE code LIKE 'PAYSTACK_PAYOUT_BALANCE:%'), 0)::text AS payout_balance_minor
             FROM accounts
            WHERE wallet_id IS NULL AND (code LIKE 'PAYSTACK_PAYOUT_IN_TRANSIT:%' OR code LIKE 'PAYSTACK_PAYOUT_BALANCE:%')
            GROUP BY currency_code ORDER BY currency_code`,
        )) as { currency_code: string; in_transit_minor: string; payout_balance_minor: string }[];
        const fees = (await manager.query(
          `SELECT w.flow_id, w.currency_code, w.principal_minor::text AS principal_minor, o.id AS observation_id
             FROM paystack_withdrawals w
             JOIN withdrawal_verifications v ON v.id = w.confirmation_verification_id
             JOIN paystack_transfer_observations o ON o.id = v.observation_id
            WHERE o.fee_charged_minor IS NULL
              AND NOT EXISTS (SELECT 1 FROM withdrawal_accounting_events e WHERE e.withdrawal_id = w.flow_id AND e.event_kind = 'PROVIDER_FEE')
            ORDER BY w.flow_id`,
        )) as { flow_id: string; currency_code: string; principal_minor: string; observation_id: string }[];
        return { receipts, nets, holds, payout, fees };
      },
      { statementTimeoutMilliseconds: this.config.reconciliation.statementTimeoutSeconds * 1000 },
    );

    for (const row of findings.receipts) {
      await context.detect({
        type: BreakType.STASH_RECEIPT_INCONSISTENT,
        subjectKey: subjectKeys.stashReceipt(row.flow_id),
        currency: row.currency_code,
        amountMinor: BigInt(row.principal_minor),
        flowId: row.flow_id,
        details: {
          withdrawalId: row.flow_id,
          flowState: row.state,
          confirmations: row.confirmations,
          reversals: row.reversals,
          receiptsLinkedToPostings: row.linked,
          principalPosted: row.principal_posted,
          reversalPosted: row.reversal_posted,
        },
      });
    }
    for (const row of findings.nets) {
      const difference = BigInt(row.receipted_minor) - BigInt(row.principal_minor);
      await context.detect({
        type: BreakType.STASH_RECEIPT_INCONSISTENT,
        subjectKey: subjectKeys.stashReceipt(`user:${row.user_id}:${row.currency_code}`),
        currency: row.currency_code,
        amountMinor: difference < 0n ? -difference : difference,
        details: { userId: row.user_id, receiptedMinor: row.receipted_minor, confirmedLessReversedPrincipalMinor: row.principal_minor },
      });
    }
    for (const row of findings.holds) {
      await context.detect({
        type: BreakType.WITHDRAWAL_RESERVATION_INCONSISTENT,
        subjectKey: subjectKeys.withdrawal(row.flow_id),
        currency: row.currency_code,
        amountMinor: BigInt(row.amount_minor),
        ...(row.state !== null ? { flowId: row.flow_id } : {}),
        details: { reservationId: row.id, flowId: row.flow_id, flowState: row.state, flowCompleted: row.completed, linkedToWithdrawal: row.linked },
      });
    }
    for (const row of findings.payout) {
      const inTransit = BigInt(row.in_transit_minor);
      if (inTransit !== 0n) {
        await context.detect({
          type: BreakType.PAYOUT_BALANCE_PROOF_FAILED,
          subjectKey: subjectKeys.payoutBalance(PROVIDER, row.currency_code),
          currency: row.currency_code,
          amountMinor: inTransit < 0n ? -inTransit : inTransit,
          details: { account: 'PAYSTACK_PAYOUT_IN_TRANSIT', expectedMinor: '0', actualMinor: row.in_transit_minor },
        });
      }
      const payoutBalance = BigInt(row.payout_balance_minor);
      if (payoutBalance < 0n) {
        // D3 (accepted): payouts booked without evidenced treasury backing. Visible, never clamped, never "clean".
        await context.detect({
          type: BreakType.PAYOUT_TREASURY_EVIDENCE_MISSING,
          subjectKey: subjectKeys.payoutBalance(PROVIDER, row.currency_code),
          currency: row.currency_code,
          amountMinor: -payoutBalance,
          details: { account: 'PAYSTACK_PAYOUT_BALANCE', balanceMinor: row.payout_balance_minor, limitation: 'D3' },
        });
      }
    }
    for (const row of findings.fees) {
      await context.detect({
        type: BreakType.PAYOUT_FEE_EVIDENCE_MISSING,
        subjectKey: subjectKeys.withdrawal(row.flow_id),
        currency: row.currency_code,
        amountMinor: 0n,
        flowId: row.flow_id,
        details: { withdrawalId: row.flow_id, observationId: row.observation_id },
      });
    }
  }

  // ── daily 6: balance evidence (D3: kept, not attributed) ──

  private async keepBalanceEvidence(context: ComponentRun, windowStart: Date, now: Date, counts: Counts): Promise<void> {
    const identity = this.config.withdrawals.accountIdentity as string;
    const balances = await this.gateway.balances();
    await this.unitOfWork.run(async (manager) => {
      const evidenceId = await this.store(balances.exchange);
      for (const balance of balances.value) {
        await manager.query(
          `INSERT INTO paystack_balance_observations (provider_account_identity, environment, currency_code, balance_minor, evidence_id)
           SELECT $1, 'test', code, $3, $4 FROM currencies WHERE code = $2`,
          [identity, balance.currency, balance.balanceMinor.toString(), evidenceId],
        );
      }
    });
    let page: string | undefined;
    for (let pages = 0; pages < this.maximumPages; pages += 1) {
      const result = await this.gateway.balanceLedger({ from: new Date(windowStart.getTime() - DAY), to: new Date(now.getTime() + 1), ...(page ? { page } : {}) });
      await this.unitOfWork.run(async (manager) => {
        const evidenceId = await this.store(result.exchange);
        for (const row of result.value.items) {
          const content = createHash('sha256')
            .update(
              ['v1', row.rowId, row.currency, row.differenceMinor, row.balanceMinor, row.modelResponsible ?? '', row.modelRow ?? '',
                row.createdAt?.toISOString() ?? '', row.updatedAt?.toISOString() ?? ''].join('|'),
              'utf8',
            )
            .digest();
          const inserted = (await manager.query(
            `INSERT INTO paystack_balance_ledger_rows
               (provider_account_identity, environment, provider_row_id, content_sha256, currency_code, difference_minor, balance_minor,
                model_responsible, model_row, provider_created_at, provider_updated_at, evidence_id)
             SELECT $1, 'test', $2, $3, code, $5, $6, $7, $8, $9, $10, $11 FROM currencies WHERE code = $4
             ON CONFLICT (provider_account_identity, environment, provider_row_id, content_sha256) DO NOTHING
             RETURNING id`,
            [identity, row.rowId, content, row.currency, row.differenceMinor.toString(), row.balanceMinor.toString(),
              row.modelResponsible?.slice(0, 64) ?? null, row.modelRow?.slice(0, 64) ?? null, row.createdAt, row.updatedAt, evidenceId],
          )) as { id: string }[];
          counts.balanceLedgerRows += inserted.length;
        }
      });
      if (!result.value.nextCursor) return;
      page = result.value.nextCursor;
    }
    context.seen.incomplete.push(`balance ledger hit the ${this.maximumPages}-page cap`);
  }

  // ── resolutions, shared ──

  private async retryAutomaticResolutions(context: ComponentRun): Promise<void> {
    for (const live of await this.breaks.live([BreakType.WITHDRAWAL_NOT_POSTED, BreakType.WITHDRAWAL_RETURN_NOT_POSTED])) {
      if (!live.flowId) continue;
      const [row] = (await this.unitOfWork.manager.query(
        `SELECT flow_instances.state, flow_instances.completed_at, paystack_withdrawals.principal_transaction_id, paystack_withdrawals.reversal_transaction_id
           FROM flow_instances JOIN paystack_withdrawals ON paystack_withdrawals.flow_id = flow_instances.id WHERE flow_instances.id = $1`,
        [live.flowId],
      )) as { state: string; completed_at: Date | null; principal_transaction_id: string | null; reversal_transaction_id: string | null }[];
      if (!row) continue;
      if (live.type === BreakType.WITHDRAWAL_NOT_POSTED && row.completed_at !== null) {
        const reference = row.principal_transaction_id ?? `withdrawal:${live.flowId}`;
        if (await this.breaks.resolve(live.id, RECONCILIATION_INITIATED_BY, ResolutionKind.FLOW_ADVANCED, reference, `withdrawal resolved: ${row.state}`)) {
          context.seen.resolved.add(live.id);
        }
      } else if (live.type === BreakType.WITHDRAWAL_RETURN_NOT_POSTED && row.state === PaystackWithdrawalState.REVERSED && row.reversal_transaction_id) {
        if (await this.breaks.resolve(live.id, RECONCILIATION_INITIATED_BY, ResolutionKind.REVERSAL_POSTED, row.reversal_transaction_id, 'withdrawal return posted')) {
          context.seen.resolved.add(live.id);
        }
      }
    }
  }

  // ── helpers ──

  private async drive(context: ComponentRun, flowId: string, includeCompleted: boolean, counts: Counts): Promise<void> {
    try {
      await WithdrawalTrigger.run({ source: 'RECONCILIATION', reconciliationRunId: context.run.id }, () => this.runner.advance(flowId, { includeCompleted }));
    } catch (error) {
      counts.driveFailures = (counts.driveFailures ?? 0) + 1;
      this.logger.error({ flowId, runId: context.run.id, err: error }, 'Reconciliation could not drive a withdrawal flow; the next run retries');
    }
  }

  private observe(context: ComponentRun, flowId: string): ReturnType<WithdrawalFlow['observeForReconciliation']> {
    return WithdrawalTrigger.run({ source: 'RECONCILIATION', reconciliationRunId: context.run.id }, () => this.withdrawals.observeForReconciliation(flowId));
  }

  /** An authoritative read of a transfer that is not ours: verify by its reference when it has one, else fetch by id. */
  private async confirm(listed: TransferObservation): Promise<TransferObservation | null> {
    try {
      if (listed.reference) {
        const verified = await this.gateway.verifyTransfer(listed.reference, {});
        return verified.found && (listed.transferId === null || verified.observation.transferId === listed.transferId) ? verified.observation : null;
      }
      if (listed.transferId) return (await this.gateway.fetchTransfer(listed.transferId, {})).value;
    } catch (error) {
      if (!(error instanceof PaystackTransferCallFailedError)) throw error;
    }
    return null;
  }

  private async intentsFor(transfer: TransferObservation): Promise<Intent[]> {
    if (!transfer.transferId && !transfer.transferCode && !transfer.reference) return [];
    return (await this.unitOfWork.manager.query(
      `SELECT paystack_withdrawals.flow_id AS "flowId", flow_instances.state
         FROM paystack_withdrawals JOIN flow_instances ON flow_instances.id = paystack_withdrawals.flow_id
        WHERE paystack_withdrawals.provider = 'paystack'
          AND (paystack_withdrawals.provider_transfer_id = $1 OR paystack_withdrawals.provider_transfer_code = $2
               OR paystack_withdrawals.provider_reference = $3)
        ORDER BY paystack_withdrawals.flow_id`,
      [transfer.transferId, transfer.transferCode, transfer.reference],
    )) as Intent[];
  }

  private async store(exchange: { operation: string; rawResponse: Buffer | null; providerCallId: string | undefined }): Promise<string> {
    if (!exchange.rawResponse) throw new InvariantViolationError('Balance evidence needs the answer\'s bytes.', { operation: exchange.operation });
    return (await this.evidence.store({ provider: 'paystack', operation: exchange.operation, content: exchange.rawResponse, providerCallId: exchange.providerCallId })).evidenceId;
  }
}

