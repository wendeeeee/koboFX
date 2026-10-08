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


/** Who owns a break: the provider whose run re-derives it, and — for Paystack — which family (component). */
export interface BreakOwner {
  readonly provider: string;
  /** `CHARGE` (funding / the simulated PSP's payments) or `TRANSFER` (withdrawals). */
  readonly family: 'CHARGE' | 'TRANSFER';
}

const WITHDRAWAL_FLOW_TYPES = ['PAYSTACK_WITHDRAWAL', 'PAYSTACK_BENEFICIARY'];

/**
 * Break ownership (WITHDRAWAL_PLAN.md §I.2): a provider's run only sweeps ("no longer detected") the breaks its own
 * families re-derive. Withdrawal subjects — `transfer:paystack:<id>`, `withdrawal:<flowId>`,
 * `payout-balance:paystack:<ccy>`, `stash-receipt:<id>` — and PAYSTACK_WITHDRAWAL / PAYSTACK_BENEFICIARY flows belong to
 * (paystack, TRANSFER): funding never annotates or dismisses them because IT did not detect them. An UNMATCHED_WEBHOOK
 * names its family in `details.family`.
 */
@Injectable()
export class BreakOwnership {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /** The owning provider (the simulated PSP's sweep treats "no owner" as its own; every withdrawal break has one). */
  async providerOf(live: Pick<ReconciliationBreak, 'subjectKey' | 'flowId'> & { details?: Record<string, unknown> }): Promise<string | null> {
    return (await this.ownerOf(live))?.provider ?? null;
  }

  async ownerOf(live: Pick<ReconciliationBreak, 'subjectKey' | 'flowId'> & { details?: Record<string, unknown> }): Promise<BreakOwner | null> {
    const transfer = /^(?:transfer|payout-balance):([a-z0-9-]{1,32}):/.exec(live.subjectKey);
    if (transfer) return { provider: transfer[1], family: 'TRANSFER' };
    if (/^(?:withdrawal|stash-receipt):/.test(live.subjectKey)) return { provider: 'paystack', family: 'TRANSFER' };
    const payment = /^payment:([a-z0-9-]{1,32}):/.exec(live.subjectKey);
    if (payment) return { provider: payment[1], family: 'CHARGE' };
    const receivable = /^receivable:([a-z0-9-]{1,32}):[A-Z]{3}$/.exec(live.subjectKey);
    if (receivable) return { provider: receivable[1], family: 'CHARGE' };
    const family = live.details?.family;
    const provider = live.details?.provider;
    if ((family === 'CHARGE' || family === 'TRANSFER') && typeof provider === 'string') return { provider, family };
    if (live.flowId) {
      const [flow] = (await this.unitOfWork.manager.query(`SELECT flow_type::text AS flow_type FROM flow_instances WHERE id = $1`, [live.flowId])) as {
        flow_type: string;
      }[];
      if (flow && WITHDRAWAL_FLOW_TYPES.includes(flow.flow_type)) return { provider: 'paystack', family: 'TRANSFER' };
      const [row] = (await this.unitOfWork.manager.query(`SELECT provider FROM funding_payments WHERE flow_id = $1`, [live.flowId])) as {
        provider: string;
      }[];
      return row ? { provider: row.provider, family: 'CHARGE' } : null;
    }
    return null;
  }
}
