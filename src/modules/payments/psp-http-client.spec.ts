import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProviderRequestRejectedError, ProviderResponseInvalidError, ProviderUnavailableError } from './payment.errors';
import { ProviderCallRecord, ProviderCallRecorder } from './provider-call-recorder';
import { PspHttpClient, PspHttpClientOptions, isRetryable } from './psp-http-client';

class CapturingRecorder {
  readonly calls: ProviderCallRecord[] = [];
  async recordQuietly(call: ProviderCallRecord): Promise<void> {
    this.calls.push(call);
  }
}

type Reply = { status: number; body: string } | 'throw-network' | 'throw-timeout';

function fakeFetch(replies: Reply[]): { fetch: typeof fetch; requests: { url: string; init: RequestInit }[] } {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchImplementation = (async (url: URL | string, init: RequestInit) => {
    requests.push({ url: String(url), init });
    const reply = replies.shift();
    if (!reply) throw new Error('no reply scripted');
    if (reply === 'throw-network') throw new TypeError('fetch failed');
    if (reply === 'throw-timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    return new Response(reply.body, { status: reply.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetch: fetchImplementation, requests };
}

function client(replies: Reply[], overrides: Partial<PspHttpClientOptions> = {}) {
  const recorder = new CapturingRecorder();
  const sleeps: number[] = [];
  const fake = fakeFetch(replies);
  const instance = new PspHttpClient(
    {
      provider: 'test-psp',
      baseUrl: 'http://psp.test',
      secretKey: 'sk_test_secret_key_value_of_32_chars',
      timeoutMilliseconds: 2000,
      readRetries: 3,
      random: () => 0.5,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      fetch: fake.fetch,
      ...overrides,
    },
    recorder as unknown as ProviderCallRecorder,
  );
  return { instance, recorder, sleeps, requests: fake.requests };
}

const OK = { status: 200, body: '{"id":"pay_1"}' };
const read = { operation: 'get-payment', method: 'GET' as const, path: '/v1/payments/pay_1', flowId: 'flow-1' };
const write = { operation: 'capture', method: 'POST' as const, path: '/v1/payments/pay_1/capture', idempotencyKey: 'capture:flow-1', body: { amount: '5' } };

describe('PSP HTTP client: retry policy (design §7.2 point 3)', () => {
  it('only reads are retryable', () => {
    expect(isRetryable('GET')).toBe(true);
    expect(isRetryable('POST')).toBe(false);
  });

  it('retries a read on timeout, network error, 5xx, 429, a 200 with an error body and malformed JSON — then succeeds', async () => {
    const { instance, recorder, sleeps, requests } = client(
      ['throw-timeout', 'throw-network', { status: 503, body: '{}' }, OK],
    );
    await expect(instance.send(read)).resolves.toEqual({ status: 200, body: { id: 'pay_1' } });
    expect(requests).toHaveLength(4);
    expect(recorder.calls.map((call) => [call.attempt, call.responseStatus ?? null, call.error ?? null])).toEqual([
      [1, null, expect.stringContaining('timed out')],
      [2, null, expect.stringContaining('network error')],
      [3, 503, 'provider error 503'],
      [4, 200, null],
    ]);
    // Full jitter, exponential: random × min(cap, base·2^retry) with random = 0.5.
    expect(sleeps).toEqual([50, 100, 200]);

    for (const reply of [{ status: 429, body: '{"error":{"code":"rate_limited"}}' }, { status: 200, body: '{"error":{"code":"busy"}}' }, { status: 200, body: '{"id": "pay' }]) {
      const retried = client([reply, OK]);
      await expect(retried.instance.send(read)).resolves.toMatchObject({ status: 200 });
      expect(retried.requests).toHaveLength(2);
    }
  });

  it('gives up after 1 + readRetries attempts with the last error', async () => {
    const { instance, requests } = client([{ status: 500, body: '{}' }, { status: 500, body: '{}' }, { status: 500, body: '{}' }, { status: 502, body: '{}' }]);
    await expect(instance.send(read)).rejects.toMatchObject({ responseStatus: 502 });
    expect(requests).toHaveLength(4);
    const malformed = client(Array.from({ length: 4 }, () => ({ status: 200, body: 'nope' })));
    await expect(malformed.instance.send(read)).rejects.toBeInstanceOf(ProviderResponseInvalidError);
  });

  it('NEVER retries a write: one attempt, whatever happens, and it carries the idempotency key', async () => {
    for (const reply of ['throw-timeout', 'throw-network', { status: 500, body: '{}' }, { status: 200, body: '{"error":{"code":"x"}}' }] as Reply[]) {
      const { instance, requests, sleeps } = client([reply, OK, OK]);
      await expect(instance.send(write)).rejects.toBeInstanceOf(reply === 'throw-network' || reply === 'throw-timeout' || (typeof reply === 'object' && reply.status >= 200) ? ProviderUnavailableError : Error);
      expect(requests).toHaveLength(1);
      expect(sleeps).toEqual([]);
      expect((requests[0].init.headers as Record<string, string>)['Idempotency-Key']).toBe('capture:flow-1');
    }
    await expect(client([]).instance.send({ ...write, idempotencyKey: undefined })).rejects.toThrow(/without an idempotency key/);
  });

  it('a 4xx is a definitive refusal: not retried, even for a read', async () => {
    const { instance, requests } = client([{ status: 404, body: '{"error":{"code":"payment_not_found"}}' }, OK]);
    await expect(instance.send(read)).rejects.toMatchObject({ responseStatus: 404, providerErrorCode: 'payment_not_found' });
    await expect(client([{ status: 400, body: '{}' }]).instance.send(read)).rejects.toBeInstanceOf(ProviderRequestRejectedError);
    expect(requests).toHaveLength(1);
  });

  it('sends the API key as a bearer header and never records headers', async () => {
    const { instance, requests, recorder } = client([OK]);
    await instance.send(read);
    expect((requests[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk_test_secret_key_value_of_32_chars');
    expect(JSON.stringify(recorder.calls)).not.toContain('sk_test_secret_key_value_of_32_chars');
    expect(recorder.calls[0]).toMatchObject({ provider: 'test-psp', operation: 'get-payment', flowId: 'flow-1', requestMethod: 'GET' });
  });

  it('enforces the per-attempt timeout against a server that hangs', async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => response.end('{}'), 1000);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const recorder = new CapturingRecorder();
    const instance = new PspHttpClient(
      { provider: 'p', baseUrl: `http://127.0.0.1:${port}`, secretKey: 'k'.repeat(32), timeoutMilliseconds: 100, readRetries: 0 },
      recorder as unknown as ProviderCallRecorder,
    );
    const started = Date.now();
    await expect(instance.send(read)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(Date.now() - started).toBeLessThan(900);
    expect(recorder.calls[0].error).toMatch(/timed out/);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
});
