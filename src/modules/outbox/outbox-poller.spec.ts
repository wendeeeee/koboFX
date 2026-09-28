import { AppConfig } from '../../config/configuration';
import { OutboxDispatcher } from './outbox-dispatcher';
import { OutboxPoller } from './outbox-poller';

describe('OutboxPoller (the worker loop)', () => {
  const config = { outbox: { batchSize: 2, pollIntervalMilliseconds: 10, maxAttempts: 3 } } as AppConfig;

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
    poller.start();
    poller.start(); // idempotent
    await new Promise((resolve) => setTimeout(resolve, 80));
    await poller.stop();
    const callsAtStop = calls;
    expect(callsAtStop).toBeGreaterThanOrEqual(4);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toBe(callsAtStop);
  });
});
