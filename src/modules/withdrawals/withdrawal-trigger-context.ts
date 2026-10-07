import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who caused a withdrawal step (WITHDRAWAL_PLAN.md §G.1, last paragraph): the typed trigger context the flow stores on
 * every authoritative observation. A reconciliation run drives flows inside `WithdrawalTrigger.run(...)`, so the verify
 * observations those steps record carry `source = RECONCILIATION` and the run's id (a W1 CHECK requires the pair).
 *
 * Without a context a step is the RESUMER's — including webhook-triggered steps: the W1 CHECK allows `source = WEBHOOK`
 * only for `operation = 'webhook.transfer'`, and a hint-triggered step records a `transfer.verify` answer (recorded delta).
 * No trigger source changes the match rules.
 */
export interface ReconciliationTrigger {
  readonly source: 'RECONCILIATION';
  readonly reconciliationRunId: string;
}

export type WithdrawalTriggerContext = ReconciliationTrigger;

const storage = new AsyncLocalStorage<WithdrawalTriggerContext>();

export const WithdrawalTrigger = {
  run<T>(context: WithdrawalTriggerContext, work: () => Promise<T>): Promise<T> {
    return storage.run(context, work);
  },
  current(): WithdrawalTriggerContext | undefined {
    return storage.getStore();
  },
};
