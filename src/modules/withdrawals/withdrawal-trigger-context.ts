import { AsyncLocalStorage } from 'node:async_hooks';


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
