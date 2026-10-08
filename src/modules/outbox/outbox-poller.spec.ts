import { AppConfig } from '../../config/configuration';
import { OutboxDispatcher } from './outbox-dispatcher';
import { OutboxPoller } from './outbox-poller';

describe('OutboxPoller (the worker loop)', () => {
  const config = { outbox: { batchSize: 2, pollIntervalMilliseconds: 10, maxAttempts: 3 } } as AppConfig;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('drains full batches back to back, sleeps when idle, survives a failing cycle, and stops cleanly', async () => {
    const results = [{ claimed: 2 }, { claimed: 2 }, 'boom', { claimed: 0 }];
    let calls = 0;
    const dispatcher = {
      dispatchDue: jest.fn(async () => {
        const next = results[Math.min(calls, results.length - 1)];
        calls += 1;
        if (next === 'boom') throw new Error('database blip');
        return { published: 0, retried: 0, deadLettered: 0, ...(next as { claimed: number }) };
      }),
    } as unknown as OutboxDispatcher;
    const poller = new OutboxPoller(dispatcher, config);
    try {
      poller.start();
      poller.start(); // idempotent
      await jest.advanceTimersByTimeAsync(0);
      expect(calls).toBe(3); // Full batches drain immediately, then the failing cycle sleeps.
      await jest.advanceTimersByTimeAsync(9);
      expect(calls).toBe(3);
      await jest.advanceTimersByTimeAsync(1);
      expect(calls).toBe(4); // The loop survives the failure.
      await jest.advanceTimersByTimeAsync(9);
      expect(calls).toBe(4); // An idle cycle also sleeps.
      await jest.advanceTimersByTimeAsync(1);
      expect(calls).toBe(5);
    } finally {
      await poller.stop();
    }
    const callsAtStop = calls;
    await jest.advanceTimersByTimeAsync(40);
    expect(calls).toBe(callsAtStop);
  });
});
