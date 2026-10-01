import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { RequestContext } from '../../common/context';
import { PollingLoop } from '../../common/polling/polling-loop';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { ExternalReconciliationJob, ExternalRunResult } from './external-reconciliation.job';
import { InternalReconciliationJob, InternalRunResult } from './internal-reconciliation.job';
import { ClaimedRun, ReconciliationRunRepository } from './reconciliation-run.repository';
import { ReconciliationRunKind, missedPeriods, periodDue } from './reconciliation-schedule';
import { ProviderReconciliationRegistry } from './provider-reconciliation';

export type RunResult = InternalRunResult | ExternalRunResult;

const KINDS: readonly ReconciliationRunKind[] = [
  ReconciliationRunKind.INTERNAL,
  ReconciliationRunKind.EXTERNAL_DAILY,
  ReconciliationRunKind.EXTERNAL_HOURLY,
];

/**
 * The worker's reconciliation loop (Phase 9 §H.8). Each tick, for each kind — nightly internal,
 * daily external, hourly sweep — on the `Clock`, in UTC:
 *
 * 1. Resume runs a dead worker left RUNNING (their lease lapsed): every step is idempotent.
 * 2. Record every period since the last one that nobody ran as MISSED — a gap is visible, never
 *    "clean". The current run catches up (the checks are cumulative).
 * 3. Claim and run the current period's run — once: `UNIQUE (kind, period_key)` + a lease, so two
 *    workers never produce two runs.
 *
 * A run that fails gives its lease back and is resumed on a later tick.
 */
@Injectable()
export class ReconciliationScheduler {
  private readonly logger = new Logger(ReconciliationScheduler.name);
  private readonly loop: PollingLoop;

  constructor(
    private readonly runs: ReconciliationRunRepository,
    private readonly internal: InternalReconciliationJob,
    private readonly external: ExternalReconciliationJob,
    private readonly providers: ProviderReconciliationRegistry,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.loop = new PollingLoop(
      ReconciliationScheduler.name,
      async () => {
        await this.tick();
        return { fullBatch: false };
      },
      () => this.config.reconciliation.tickMilliseconds,
    );
  }

  start(): void {
    if (this.config.reconciliation.enabled) this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  /** One scheduling pass over every kind. Returns the runs executed. */
  async tick(): Promise<RunResult[]> {
    const results: RunResult[] = [];
    for (const kind of KINDS) {
      try {
        results.push(...(await this.runDue(kind)));
      } catch {
        // Logged and released by `runPeriod`; the other kinds still run this tick.
      }
    }
    // Every other provider's external runs (Paystack, when enabled): their own periods, their own leases.
    for (const provider of this.providers.all()) {
      for (const kind of [ReconciliationRunKind.EXTERNAL_DAILY, ReconciliationRunKind.EXTERNAL_HOURLY]) {
        try {
          results.push(...(await this.runDue(kind, this.clock.now(), provider.provider)));
        } catch {
          // Logged and released by `runPeriod`.
        }
      }
    }
    return results;
  }

  /** `provider` null: the configured simulated PSP's run (and INTERNAL), exactly as before. */
  async runDue(kind: ReconciliationRunKind, now: Date = this.clock.now(), provider: string | null = null): Promise<RunResult[]> {
    const current = periodDue(kind, now, this.config.reconciliation);
    const results: RunResult[] = [];
    for (const period of await this.runs.abandonedPeriods(kind, provider)) {
      if (period === current) continue;
      const resumed = await this.runPeriod(kind, period, provider);
      if (resumed) results.push(resumed);
    }
    const last = await this.runs.latestPeriod(kind, provider);
    if (last !== null && last < current) {
      for (const period of missedPeriods(last, current)) {
        await this.runs.recordMissed(kind, period, provider);
        this.logger.warn({ kind, provider, periodKey: period }, 'Reconciliation period missed (no run); recorded');
      }
    }
    const result = await this.runPeriod(kind, current, provider);
    if (result) results.push(result);
    return results;
  }

  /** Claim and run one period (resuming it if a dead worker left it). `null`: not ours to run. */
  async runPeriod(kind: ReconciliationRunKind, periodKey: string, provider: string | null = null): Promise<RunResult | null> {
    const run = await this.runs.claim(kind, periodKey, this.config.reconciliation.leaseSeconds, provider);
    if (!run) return null;
    return RequestContext.run({ correlationId: `reconciliation-${randomUUID()}` }, async () => {
      try {
        return await this.execute(run);
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        this.logger.error({ runId: run.id, kind, periodKey, attempts: run.attempts, err: error }, 'Reconciliation run failed; it will be resumed');
        await this.runs.release(run, message).catch(() => undefined);
        throw error;
      }
    });
  }

  private execute(run: ClaimedRun): Promise<RunResult> {
    if (run.provider !== null) {
      const reconciliation = this.providers.find(run.provider);
      if (!reconciliation) throw new Error(`No reconciliation registered for provider ${run.provider}.`);
      if (run.kind === ReconciliationRunKind.EXTERNAL_DAILY) return reconciliation.runDaily(run);
      if (run.kind === ReconciliationRunKind.EXTERNAL_HOURLY) return reconciliation.runHourly(run);
      throw new Error(`A ${run.kind} run cannot belong to provider ${run.provider}.`);
    }
    switch (run.kind) {
      case ReconciliationRunKind.INTERNAL:
        return this.internal.run(run);
      case ReconciliationRunKind.EXTERNAL_DAILY:
        return this.external.runDaily(run);
      case ReconciliationRunKind.EXTERNAL_HOURLY:
        return this.external.runHourly(run);
    }
  }
}
