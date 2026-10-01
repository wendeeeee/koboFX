import { Injectable } from '@nestjs/common';
import { InvariantViolationError } from '../../common/errors';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import type { ReconciliationBreak } from './break.service';
import type { ExternalRunResult } from './external-reconciliation.job';
import type { ClaimedRun } from './reconciliation-run.repository';

/**
 * External reconciliation of a provider OTHER than the configured simulated PSP (PAYSTACK_PLAN.md C7): its own daily
 * and hourly runs (`reconciliation_runs.provider`), its own breaks. Registered by the provider's module when enabled.
 */
export interface ProviderReconciliation {
  readonly provider: string;
  runDaily(run: ClaimedRun): Promise<ExternalRunResult>;
  runHourly(run: ClaimedRun): Promise<ExternalRunResult>;
}

@Injectable()
export class ProviderReconciliationRegistry {
  private readonly registered = new Map<string, ProviderReconciliation>();

  register(reconciliation: ProviderReconciliation): void {
    if (this.registered.has(reconciliation.provider)) {
      throw new InvariantViolationError(`Two reconciliations registered for ${reconciliation.provider}.`);
    }
    this.registered.set(reconciliation.provider, reconciliation);
  }

  all(): readonly ProviderReconciliation[] {
    return [...this.registered.values()];
  }

  find(provider: string): ProviderReconciliation | undefined {
    return this.registered.get(provider);
  }
}

/**
 * Which provider a break is about — so each provider's run sweeps ("no longer detected") only its OWN breaks:
 * a `payment:{provider}:…` or `receivable:{provider}:{currency}` subject names it; a break on a flow belongs to its
 * funding payment's provider; anything else (`receivable:{currency}`, internal subjects) to none — the simulated PSP's
 * run keeps treating those exactly as before.
 */
@Injectable()
export class BreakOwnership {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async providerOf(live: Pick<ReconciliationBreak, 'subjectKey' | 'flowId'>): Promise<string | null> {
    const payment = /^payment:([a-z0-9-]{1,32}):/.exec(live.subjectKey);
    if (payment) return payment[1];
    const receivable = /^receivable:([a-z0-9-]{1,32}):[A-Z]{3}$/.exec(live.subjectKey);
    if (receivable) return receivable[1];
    if (live.flowId) {
      const [row] = (await this.unitOfWork.manager.query(`SELECT provider FROM funding_payments WHERE flow_id = $1`, [live.flowId])) as {
        provider: string;
      }[];
      return row?.provider ?? null;
    }
    return null;
  }
}
