import { exactJsonBody } from './exact-json';
import { ProviderCallRecord, ProviderCallRecorder } from './provider-call-recorder';
import { ProviderHttpClient, ProviderHttpClientOptions, ResponseClassifier } from './provider-http-client';

class CapturingRecorder {
  readonly calls: ProviderCallRecord[] = [];
  async recordQuietly(call: ProviderCallRecord): Promise<string> {
    this.calls.push(call);
    return String(this.calls.length);
  }
}

const ACCOUNT = '0123456789';

function setup(reply: { status: number; body: string } | { throws: unknown }, overrides: Partial<ProviderHttpClientOptions> = {}) {
  const recorder = new CapturingRecorder();
  const sent: { url: string; body: string | undefined; contentType: string | undefined }[] = [];
  const client = new ProviderHttpClient(
    {
      provider: 'paystack',
      label: 'Paystack',
      baseUrl: 'http://paystack.test',
      timeoutMilliseconds: 1000,
      readRetries: 0,
      secrets: ['sk_test_secretsecret'],
      recordResponseAs: 'redacted-lossless-json',
      extraRedactedKeys: /^(account_number|account_name)$/,
      sleep: async () => undefined,
      fetch: (async (url: URL, init: RequestInit) => {
        sent.push({ url: String(url), body: init.body as string | undefined, contentType: (init.headers as Record<string, string>)['Content-Type'] });
        if ('throws' in reply) throw reply.throws;
        return new Response(reply.body, { status: reply.status });
      }) as unknown as typeof fetch,
      ...overrides,
    },
    recorder as unknown as ProviderCallRecorder,
  );
  return { client, recorder, sent };
}

const ok: ResponseClassifier<string> = (status, text) =>
  status < 300 && text.startsWith('{') ? { outcome: 'OK', value: text } : { outcome: 'INVALID', error: `bad ${status}` };

describe('exactJsonBody', () => {
  it('writes bigint as exact JSON integers, beyond 2^53', () => {
    expect(exactJsonBody({ source: 'balance', amount: 9_007_199_254_740_993n, nested: { list: [1n, 'x', null, true] } })).toBe(
      '{"source":"balance","amount":9007199254740993,"nested":{"list":[1,"x",null,true]}}',
    );
    expect(exactJsonBody({ amount: -9_223_372_036_854_775_808n, skipped: undefined })).toBe('{"amount":-9223372036854775808}');
  });

  it('refuses JavaScript numbers and integers outside signed 64 bits', () => {
    expect(() => exactJsonBody({ amount: 300000 as unknown as bigint })).toThrow(/JavaScript number is not allowed/);
    expect(() => exactJsonBody({ amount: 9_223_372_036_854_775_808n })).toThrow(/signed 64 bits/);
  });
});

describe('ProviderHttpClient — exact bodies and privacy', () => {
  it('sends a raw body verbatim as JSON and records only the sanitised copy', async () => {
    const { client, recorder, sent } = setup({ status: 200, body: '{"status":true}' });
    const rawBody = exactJsonBody({ amount: 300000n, recipient: 'RCP_x', reference: 'withdrawal-abc' });
    await client.send({ operation: 'transfer.initiate', method: 'POST', path: '/transfer', rawBody, recordedBody: { amount: '300000', recipient: '[REDACTED]' }, classify: ok });
    expect(sent[0].body).toBe('{"amount":300000,"recipient":"RCP_x","reference":"withdrawal-abc"}');
    expect(sent[0].contentType).toBe('application/json');
    expect(recorder.calls[0].requestBody).toEqual({ amount: '300000', recipient: '[REDACTED]' });
  });

  it('refuses a raw body without a recorded copy, or alongside `body`', async () => {
    const { client } = setup({ status: 200, body: '{}' });
    await expect(client.send({ operation: 'x', method: 'POST', path: '/x', rawBody: '{}', classify: ok })).rejects.toThrow(/needs a `recordedBody`/);
    await expect(
      client.send({ operation: 'x', method: 'POST', path: '/x', rawBody: '{}', recordedBody: {}, body: { a: 1 }, classify: ok }),
    ).rejects.toThrow(/replaces `body`/);
  });

  it('scrubs a request’s sensitive values — raw and URL-encoded — from the path, errors and raw bodies', async () => {
    const path = `/bank/resolve?account_number=${ACCOUNT}&bank_code=058`;
    const failing = setup({ throws: new Error(`connect ECONNREFUSED http://paystack.test${path} (${encodeURIComponent(ACCOUNT)})`) });
    await expect(
      failing.client.send({ operation: 'bank.resolve', method: 'GET', path, sensitiveValues: [ACCOUNT], classify: ok }),
    ).rejects.toThrow();
    const record = failing.recorder.calls[0];
    expect(record.requestPath).toBe('/bank/resolve?account_number=[REDACTED]&bank_code=058');
    expect(record.error).not.toContain(ACCOUNT);
    expect(JSON.stringify(failing.recorder.calls)).not.toContain(ACCOUNT);

    const echoing = setup({ status: 400, body: `<html>No account ${ACCOUNT} at bank 058</html>` });
    await expect(echoing.client.send({ operation: 'bank.resolve', method: 'GET', path, sensitiveValues: [ACCOUNT], classify: ok })).rejects.toThrow();
    expect(JSON.stringify(echoing.recorder.calls)).not.toContain(ACCOUNT);
  });

  it('withholds unparsed bodies entirely when configured (the exact bytes go to protected evidence instead)', async () => {
    const { client, recorder } = setup({ status: 502, body: '<html>Bad gateway for Ada Lovelace</html>' }, { withholdUnparsedBodies: true });
    await expect(client.send({ operation: 'transfer.verify', method: 'GET', path: '/transfer/verify/x', classify: ok })).rejects.toThrow();
    expect(recorder.calls[0].responseBody).toEqual({ unparsed: '[WITHHELD: 41 bytes]' });
    expect(JSON.stringify(recorder.calls)).not.toContain('Lovelace');
  });

  it('redacts account fields by key and keeps every digit of the rest', async () => {
    const body = `{"status":true,"data":{"account_number":"${ACCOUNT}","account_name":"ADA LOVELACE","amount":9007199254740993}}`;
    const { client, recorder } = setup({ status: 200, body });
    await client.send({ operation: 'bank.resolve', method: 'GET', path: '/bank/resolve', classify: ok });
    expect(recorder.calls[0].responseBodyText).toBe(
      '{"status":true,"data":{"account_number":"[REDACTED]","account_name":"[REDACTED]","amount":9007199254740993}}',
    );
  });
});
