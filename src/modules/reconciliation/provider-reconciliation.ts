import { Injectable } from '@nestjs/common';
import { InvariantViolationError } from '../../common/errors';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import type { ReconciliationBreak } from './break.service';
import type { ExternalRunResult } from './external-reconciliation.job';
import type { ClaimedRun } from './reconciliation-run.repository';


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
