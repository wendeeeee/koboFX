import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContextStore {
  readonly correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

/**
 * Per-request context propagated through async calls (design §10). Anything that
 * logs or records provenance reads the correlation id from here, not from arguments.
 */
export const RequestContext = {
  run<T>(store: RequestContextStore, fn: () => T): T {
    return storage.run(store, fn);
  },
  current(): RequestContextStore | undefined {
    return storage.getStore();
  },
  correlationId(): string | undefined {
    return storage.getStore()?.correlationId;
  },
};
