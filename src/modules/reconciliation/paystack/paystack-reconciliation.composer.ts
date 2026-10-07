import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InvariantViolationError } from '../../../common/errors';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { BREAK_POLICIES, BreakType } from '../break-types';
import { BreakCandidate, BreakService } from '../break.service';
import { ExternalRunResult } from '../external-reconciliation.job';
import { BreakOwnership, ProviderReconciliation, ProviderReconciliationRegistry } from '../provider-reconciliation';
import { ClaimedRun, ReconciliationRunRepository, ReconciliationRunStatus } from '../reconciliation-run.repository';
import { RECONCILIATION_INITIATED_BY } from '../settlement-posting';
import {
  ComponentRun,
  PaystackReconciliationComponent,
  PaystackReconciliationFamily,
  ReconciliationScanIncompleteError,
  Seen,
} from './paystack-reconciliation-run';

const FAMILY_ORDER = [PaystackReconciliationFamily.CHARGE, PaystackReconciliationFamily.TRANSFER];

/**
 * THE Paystack reconciliation (WITHDRAWAL_PLAN.md §I.2): exactly one `ProviderReconciliation` for `paystack`, loaded
 * wherever a Paystack key is configured (it lives in `PaystackModule`, which funding and transfers both import).
 * Funding (CHARGE) and withdrawals (TRANSFER) are components registered with it; each claimed run executes every
 * registered component with ONE shared `Seen`, then — once — sweeps "no longer detected" over the families that
 * actually ran, then finishes the run. An incomplete scan (a page cap, an unreadable page) means no sweep and no
 * finish: the run is released and resumed, and can never be CLEAN on partial coverage.
 */
@Injectable()
export class PaystackReconciliationComposer implements ProviderReconciliation, OnModuleInit {
  readonly provider: string;
  private readonly logger = new Logger(PaystackReconciliationComposer.name);
  private readonly components = new Map<PaystackReconciliationFamily, PaystackReconciliationComponent>();

  constructor(
    private readonly breaks: BreakService,
    private readonly ownership: BreakOwnership,
    private readonly runs: ReconciliationRunRepository,
    private readonly registry: ProviderReconciliationRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.provider = config.paystack.name;
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** Called by each component's module at init. One component per family. */
  addComponent(component: PaystackReconciliationComponent): void {
    if (this.components.has(component.family)) {
      throw new InvariantViolationError(`Two Paystack reconciliation components for the ${component.family} family.`);
    }
    this.components.set(component.family, component);
  }

  families(): PaystackReconciliationFamily[] {
    return FAMILY_ORDER.filter((family) => this.components.has(family));
  }

  async runDaily(run: ClaimedRun): Promise<ExternalRunResult> {
    const { seen, counts, ran } = await this.runComponents(run, (component, context) => component.runDaily(context));
    if (seen.incomplete.length > 0) throw new ReconciliationScanIncompleteError(run.id, seen.incomplete);
    await this.escalateNoLongerDetected(run, seen, ran);
    return this.finish(run, seen, counts, ran);
  }

  async runHourly(run: ClaimedRun): Promise<ExternalRunResult> {
    const { seen, counts, ran } = await this.runComponents(run, (component, context) => component.runHourly(context));
    if (seen.incomplete.length > 0) throw new ReconciliationScanIncompleteError(run.id, seen.incomplete);
    return this.finish(run, seen, counts, ran);
  }

  private async runComponents(
    run: ClaimedRun,
    work: (component: PaystackReconciliationComponent, context: ComponentRun) => Promise<Record<string, number> | null>,
  ): Promise<{ seen: Seen; counts: Record<string, Record<string, number>>; ran: PaystackReconciliationFamily[] }> {
    const seen = new Seen();
    const context: ComponentRun = {
      run,
      seen,
      detect: async (candidate: BreakCandidate) => {
        const detection = await this.breaks.detectAndRecord(run.id, candidate);
        seen.note(detection.breakId, candidate.type);
        return detection.breakId;
      },
      heartbeat: () => this.runs.heartbeat(run, this.config.reconciliation.leaseSeconds),
    };
    const counts: Record<string, Record<string, number>> = {};
    const ran: PaystackReconciliationFamily[] = [];
    for (const family of this.families()) {
      const result = await work(this.components.get(family) as PaystackReconciliationComponent, context);
      if (result === null) continue;
      counts[family] = result;
      ran.push(family);
      await context.heartbeat();
    }
    return { seen, counts, ran };
  }

  /**
   * ONE sweep, after every component: a live break re-derived daily that no component detected this run is escalated
   * (or annotated) — never resolved. Only breaks of families that RAN are touched: funding never dismisses a withdrawal
   * break merely because funding did not see it, and a family that did not run proves nothing.
   */
  private async escalateNoLongerDetected(run: ClaimedRun, seen: Seen, ran: readonly PaystackReconciliationFamily[]): Promise<void> {
    const types = (Object.keys(BREAK_POLICIES) as BreakType[]).filter((type) => BREAK_POLICIES[type].rederivedBy === 'EXTERNAL_DAILY');
    for (const live of await this.breaks.live(types)) {
      if (seen.detected.has(live.id) || seen.resolved.has(live.id)) continue;
      const owner = await this.ownership.ownerOf(live);
      if (!owner || owner.provider !== this.provider || !ran.includes(owner.family as PaystackReconciliationFamily)) continue;
      const note = `No longer detected by Paystack run ${run.id} (${run.periodKey}); not resolved: no cause was named.`;
      if (!(await this.breaks.escalate(live.id, RECONCILIATION_INITIATED_BY, note))) await this.breaks.annotate(live.id, note);
    }
  }

  private async finish(
    run: ClaimedRun,
    seen: Seen,
    counts: Record<string, Record<string, number>>,
    ran: readonly PaystackReconciliationFamily[],
  ): Promise<ExternalRunResult> {
    const status = seen.detected.size === 0 ? ReconciliationRunStatus.CLEAN : ReconciliationRunStatus.BREAKS_FOUND;
    const summary = {
      clean: status === ReconciliationRunStatus.CLEAN,
      provider: this.provider,
      families: [...ran],
      // Each family's own counts, and (for compatibility with the funding-only summary) funding's at the top level.
      ...(counts[PaystackReconciliationFamily.CHARGE] ?? {}),
      byFamily: counts,
      breaksDetected: seen.detected.size,
      breaksResolved: seen.resolved.size,
      detectedByType: seen.counts,
    };
    await this.runs.finish(run, status, summary, null);
    const log = { runId: run.id, kind: run.kind, provider: this.provider, periodKey: run.periodKey, status, families: ran, detected: seen.detected.size };
    if (status === ReconciliationRunStatus.CLEAN) this.logger.log(log, 'Paystack reconciliation finished');
    else this.logger.warn(log, 'Paystack reconciliation found breaks');
    return { runId: run.id, status, detectedBreakIds: [...seen.detected], resolvedBreakIds: [...seen.resolved], summary };
  }
}
