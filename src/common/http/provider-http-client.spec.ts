import { ProviderCallRecord, ProviderCallRecorder } from './provider-call-recorder';
import { ProviderHttpClient, ProviderHttpClientOptions, ResponseClassifier } from './provider-http-client';
import { ProviderRequestRejectedError, ProviderResponseInvalidError, ProviderUnavailableError } from './provider.errors';

class CapturingRecorder {
  readonly calls: ProviderCallRecord[] = [];
  async recordQuietly(call: ProviderCallRecord): Promise<string> {
    this.calls.push(call);
    return String(this.calls.length);
  }
}

const SECRET = 'a1b2c3d4e5f6a1b2c3d4e5f6';

type Reply = { status: number; body: string } | { throws: unknown };

function setup(replies: Reply[], overrides: Partial<ProviderHttpClientOptions> = {}) {
  const recorder = new CapturingRecorder();
  const urls: string[] = [];
  const sleeps: number[] = [];
  const client = new ProviderHttpClient(
    {
      provider: 'rates',
      label: 'Rates',
      baseUrl: 'http://rates.test',
      timeoutMilliseconds: 1000,
      readRetries: 3,
      secrets: [SECRET],
      recordResponseAs: 'raw-json-text',
      random: () => 0.5,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      fetch: (async (url: URL) => {
        urls.push(String(url));
        const reply = replies.shift();
        if (!reply) throw new Error('no reply scripted');
        if ('throws' in reply) throw reply.throws;
        return new Response(reply.body, { status: reply.status });
      }) as unknown as typeof fetch,
      ...overrides,
    },
    recorder as unknown as ProviderCallRecorder,
  );
  return { client, recorder, urls, sleeps };
}

const classify: ResponseClassifier<string> = (status, text) => {
  if (status === 403) return { outcome: 'DEFINITIVE', error: 'invalid-key', providerErrorCode: 'invalid-key' };
  if (status >= 500) return { outcome: 'TRANSIENT', error: `server ${status}` };
  if (!text.startsWith('{')) return { outcome: 'INVALID', error: 'not JSON' };
  return { outcome: 'OK', value: text };
};

const request = {
  operation: 'latest',
  method: 'GET' as const,
  path: `/v6/${SECRET}/latest/USD`,
  recordedPath: '/v6/[REDACTED]/latest/USD',
  classify,
};

describe('ProviderHttpClient (the shared provider transport)', () => {
  it('sends the real path but records only the redacted one, and returns the adapter value + the evidence row id', async () => {
    const { client, recorder, urls } = setup([{ status: 200, body: '{"rate":1530.123456789012345}' }]);
    const response = await client.send(request);
    expect(urls).toEqual([`http://rates.test/v6/${SECRET}/latest/USD`]);
    expect(response).toEqual({ status: 200, value: '{"rate":1530.123456789012345}', providerCallId: '1' });
    expect(recorder.calls[0]).toMatchObject({ requestPath: '/v6/[REDACTED]/latest/USD', responseStatus: 200 });
    // Raw text is recorded verbatim (Postgres casts it to JSONB; no JavaScript number in between).
    expect(recorder.calls[0].responseBodyText).toBe('{"rate":1530.123456789012345}');
    expect(recorder.calls[0].responseBody).toBeUndefined();
  });

  it('scrubs every configured secret from a path, an error text and a raw body — even when the adapter forgets', async () => {
    const { client, recorder } = setup([
      { throws: new TypeError(`fetch failed for http://rates.test/v6/${SECRET}/latest/USD`) },
      { status: 200, body: `{"echo":"${SECRET}"}` },
    ]);
    await client.send({ ...request, recordedPath: undefined });
    const everything = JSON.stringify(recorder.calls);
    expect(everything).not.toContain(SECRET);
    expect(recorder.calls[0].error).toMatch(/^network error: fetch failed for .*\[REDACTED\]/);
    expect(recorder.calls[1].responseBodyText).toBe('{"echo":"[REDACTED]"}');
    expect(client.scrub(`x${SECRET}y${SECRET}`)).toBe('x[REDACTED]y[REDACTED]');
  });

  it('never puts the URL in an exception message', async () => {
    const { client } = setup([{ throws: Object.assign(new Error(`timeout at ${SECRET}`), { name: 'TimeoutError' }) }], { readRetries: 0 });
    const error = (await client.send(request).catch((caught: unknown) => caught)) as Error;
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error.message).toBe('Rates latest timed out');
  });

  it('a body that is not JSON is recorded as unparsed text, scrubbed', async () => {
    const { client, recorder } = setup([{ status: 200, body: `<html>${SECRET}</html>` }], { readRetries: 0 });
    await expect(client.send(request)).rejects.toBeInstanceOf(ProviderResponseInvalidError);
    expect(recorder.calls[0].responseBody).toEqual({ unparsed: '<html>[REDACTED]</html>' });
  });

  it('redacted-json mode records the parsed body (key-redacted by the recorder)', async () => {
    const { client, recorder } = setup([{ status: 200, body: '{"a":1}' }], { recordResponseAs: 'redacted-json' });
    await client.send(request);
    expect(recorder.calls[0].responseBody).toEqual({ a: 1 });
    expect(recorder.calls[0].responseBodyText).toBeUndefined();
  });

  it('retries transient and invalid answers, never a definitive refusal', async () => {
    const retried = setup([{ status: 503, body: '' }, { status: 200, body: 'garbage' }, { status: 200, body: '{}' }]);
    await expect(retried.client.send(request)).resolves.toMatchObject({ value: '{}' });
    expect(retried.sleeps).toEqual([50, 100]);

    const refused = setup([{ status: 403, body: '{}' }, { status: 200, body: '{}' }]);
    await expect(refused.client.send(request)).rejects.toMatchObject({ responseStatus: 403, providerErrorCode: 'invalid-key' });
    await expect(setup([{ status: 403, body: '{}' }]).client.send(request)).rejects.toBeInstanceOf(ProviderRequestRejectedError);
    expect(refused.urls).toHaveLength(1);
  });

  it('beforeAttempt runs before every attempt, and throwing from it sends nothing more', async () => {
    const { client, urls } = setup([{ status: 503, body: '' }, { status: 503, body: '' }, { status: 200, body: '{}' }]);
    const attempts: number[] = [];
    const spent = new Error('budget spent');
    const outcome = await client
      .send({
        ...request,
        beforeAttempt: async (attempt) => {
          attempts.push(attempt);
          if (attempt === 3) throw spent;
        },
      })
      .catch((error: unknown) => error);
    expect(outcome).toBe(spent);
    expect(attempts).toEqual([1, 2, 3]);
    expect(urls).toHaveLength(2);
  });

  it('maximumAttempts overrides the retry count; a non-retryable request gets one attempt', async () => {
    const single = setup([{ status: 503, body: '' }, { status: 200, body: '{}' }]);
    await expect(single.client.send({ ...request, maximumAttempts: 1 })).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(single.urls).toHaveLength(1);
    const write = setup([{ status: 503, body: '' }, { status: 200, body: '{}' }]);
    await expect(write.client.send({ ...request, method: 'POST' })).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(write.urls).toHaveLength(1);
  });
});
