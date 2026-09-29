import { ProviderCallRecord, ProviderCallRecorder } from '../../../common/http/provider-call-recorder';
import { ProviderHttpClient } from '../../../common/http/provider-http-client';
import { MockExchangeRateApi } from '../../../mock-exchange-rate-api/mock-exchange-rate-api';
import { ProviderRequestBudgetSpentError } from '../fx.errors';
import { FetchFailureKind } from '../poll-schedule';
import { ExchangeRateApiProvider, classifyExchangeRateApiResponse, failureKindOf } from './exchange-rate-api.provider';

class CapturingRecorder {
  readonly calls: ProviderCallRecord[] = [];
  async recordQuietly(call: ProviderCallRecord): Promise<string> {
    this.calls.push(call);
    return String(this.calls.length);
  }
}

const API_KEY = 'f00dfacecafe1234abcd5678';
const KNOWN = ['USD', 'NGN', 'EUR', 'GBP'];

describe('ExchangeRate-API adapter against the simulated provider (real HTTP)', () => {
  const api = new MockExchangeRateApi({ apiKey: API_KEY });
  let url: string;

  beforeAll(async () => {
    url = await api.start();
  });
  afterAll(() => api.stop());
  beforeEach(() => api.clearFaults());

  function provider(mode: 'open' | 'keyed', options: { key?: string; timeoutMilliseconds?: number; readRetries?: number } = {}) {
    const recorder = new CapturingRecorder();
    const key = options.key ?? API_KEY;
    const client = new ProviderHttpClient(
      {
        provider: 'exchange-rate-api',
        label: 'ExchangeRate-API',
        baseUrl: url,
        timeoutMilliseconds: options.timeoutMilliseconds ?? 1000,
        readRetries: options.readRetries ?? 3,
        secrets: mode === 'keyed' ? [key] : [],
        recordResponseAs: 'raw-json-text',
        sleep: async () => undefined,
      },
      recorder as unknown as ProviderCallRecorder,
    );
    const adapter = new ExchangeRateApiProvider(
      { name: 'exchange-rate-api', baseUrl: mode === 'keyed' ? `${url}/v6/{apiKey}/latest` : `${url}/v6/latest`, apiKey: mode === 'keyed' ? key : undefined },
      client,
    );
    return { adapter, recorder };
  }

  it.each(['open', 'keyed'] as const)('%s endpoint: reads USD-based mids exactly, one call for every pair', async (mode) => {
    const publishedAt = new Date('2026-09-29T00:02:31Z');
    api.publish({ rates: { USD: '1', NGN: '1530.123456789012345', EUR: '0.879241', GBP: '0.754467', XAU: '0.0004' }, publishedAt, nextUpdateAt: new Date('2026-09-30T00:09:01Z') });
    const before = api.requests;
    const { adapter, recorder } = provider(mode);
    const result = await adapter.fetchLatest({ knownCurrencies: KNOWN });
    expect(api.requests - before).toBe(1);
    if (result.kind !== 'RATES') throw new Error(JSON.stringify(result));
    expect(result.rates.providerUpdatedAt).toEqual(publishedAt);
    expect(result.rates.rates.get('NGN')?.toFixed()).toBe('1530.123456789012345');
    expect([...result.rates.rates.keys()].sort()).toEqual(['EUR', 'GBP', 'NGN', 'USD']);
    expect(result.providerCallId).toBe('1');
    // The evidence keeps every digit (raw text → JSONB) and never the key.
    expect(recorder.calls[0].responseBodyText).toContain('1530.123456789012345');
  });

  it('the API key travels in the path but never reaches a recorded row, error text or exception', async () => {
    const { adapter, recorder } = provider('keyed');
    api.failNext({ kind: 'server-error' }, { kind: 'hang', milliseconds: 3000 });
    const result = await adapter.fetchLatest({ knownCurrencies: KNOWN });
    expect(result.kind).toBe('RATES');
    const everything = JSON.stringify(recorder.calls) + JSON.stringify(result);
    expect(everything).not.toContain(API_KEY);
    expect(recorder.calls.map((call) => call.requestPath)).toEqual([
      '/v6/[REDACTED]/latest/USD'.replace(/^/, `${url}`),
      `${url}/v6/[REDACTED]/latest/USD`,
      `${url}/v6/[REDACTED]/latest/USD`,
    ]);
  });

  it('a wrong key is refused with the recorded shape (HTTP 403 invalid-key): definitive, never retried', async () => {
    const before = api.requests;
    const { adapter } = provider('keyed', { key: 'wrongwrongwrong123' });
    await expect(adapter.fetchLatest({ knownCurrencies: KNOWN })).resolves.toMatchObject({
      kind: 'FAILURE',
      failure: FetchFailureKind.CREDENTIALS_REJECTED,
      providerErrorCode: 'invalid-key',
    });
    expect(api.requests - before).toBe(1);
  });

  it.each([
    ['quota-reached', FetchFailureKind.QUOTA_REACHED],
    ['invalid-key', FetchFailureKind.CREDENTIALS_REJECTED],
    ['inactive-account', FetchFailureKind.CREDENTIALS_REJECTED],
    ['unsupported-code', FetchFailureKind.REQUEST_REJECTED],
    ['malformed-request', FetchFailureKind.REQUEST_REJECTED],
    ['a-future-error-type', FetchFailureKind.REQUEST_REJECTED],
  ])('error-type %s → %s, one request only — whether it comes with a 200 or a 4xx', async (errorType, kind) => {
    for (const status of [200, 403]) {
      api.failNext({ kind: 'error-type', errorType, status }, { kind: 'error-type', errorType, status });
      const before = api.requests;
      const result = await provider('open').adapter.fetchLatest({ knownCurrencies: KNOWN });
      expect(result).toMatchObject({ kind: 'FAILURE', failure: kind, providerErrorCode: errorType });
      expect(api.requests - before).toBe(1);
      api.clearFaults();
    }
  });

  it('a 429 (the open endpoint lockout) is not retried inside the lockout', async () => {
    api.failNext({ kind: 'rate-limited' }, { kind: 'rate-limited' });
    const before = api.requests;
    await expect(provider('open').adapter.fetchLatest({ knownCurrencies: KNOWN })).resolves.toMatchObject({ failure: FetchFailureKind.RATE_LIMITED });
    expect(api.requests - before).toBe(1);
  });

  it('5xx, garbage and timeouts are retried (reads only), then reported transient / invalid', async () => {
    api.failNext({ kind: 'server-error' }, { kind: 'garbage' }, { kind: 'hang', milliseconds: 500 });
    const before = api.requests;
    const recovered = await provider('open', { timeoutMilliseconds: 200 }).adapter.fetchLatest({ knownCurrencies: KNOWN });
    expect(recovered.kind).toBe('RATES');
    expect(api.requests - before).toBe(4);

    api.failNext(...Array.from({ length: 4 }, () => ({ kind: 'server-error' as const })));
    await expect(provider('open').adapter.fetchLatest({ knownCurrencies: KNOWN })).resolves.toMatchObject({ failure: FetchFailureKind.TRANSIENT });
    api.failNext(...Array.from({ length: 4 }, () => ({ kind: 'garbage' as const })));
    await expect(provider('open').adapter.fetchLatest({ knownCurrencies: KNOWN })).resolves.toMatchObject({ failure: FetchFailureKind.INVALID_RESPONSE });
  });

  it('a single attempt when asked (the synchronous catch-up), and the budget hook can stop every attempt', async () => {
    api.failNext({ kind: 'server-error' }, { kind: 'server-error' });
    const before = api.requests;
    await expect(provider('open').adapter.fetchLatest({ knownCurrencies: KNOWN, maximumAttempts: 1 })).resolves.toMatchObject({ failure: FetchFailureKind.TRANSIENT });
    expect(api.requests - before).toBe(1);
    api.clearFaults();

    const spent = await provider('open').adapter.fetchLatest({
      knownCurrencies: KNOWN,
      beforeAttempt: async () => {
        throw new ProviderRequestBudgetSpentError('DAY', 24, 24);
      },
    });
    expect(spent).toMatchObject({ kind: 'FAILURE', failure: FetchFailureKind.BUDGET_SPENT });
    expect(api.requests - before).toBe(1);
  });

  it('a base_code other than USD is read, and left for the sanity checks to refuse', async () => {
    api.publish({ baseCode: 'EUR', publishedAt: new Date(), nextUpdateAt: new Date(Date.now() + 3_600_000) });
    const result = await provider('open').adapter.fetchLatest({ knownCurrencies: KNOWN });
    api.publish({ baseCode: 'USD', publishedAt: new Date(), nextUpdateAt: new Date(Date.now() + 3_600_000) });
    expect(result).toMatchObject({ kind: 'RATES', rates: { baseCurrency: 'EUR' } });
  });
});

describe('classification (pure)', () => {
  it('reads the body before the status: an error body is definitive on any status', () => {
    expect(classifyExchangeRateApiResponse(200, '{"result":"error","error-type":"quota-reached"}', [])).toMatchObject({ outcome: 'DEFINITIVE', providerErrorCode: 'quota-reached' });
    expect(classifyExchangeRateApiResponse(503, '{"result":"error","error-type":"quota-reached"}', [])).toMatchObject({ outcome: 'DEFINITIVE' });
    expect(classifyExchangeRateApiResponse(503, 'Service Unavailable', [])).toMatchObject({ outcome: 'TRANSIENT' });
    expect(classifyExchangeRateApiResponse(200, 'nope', [])).toMatchObject({ outcome: 'INVALID' });
    const success = '{"result":"success","base_code":"USD","time_last_update_unix":1,"time_next_update_unix":2,"rates":{}}';
    expect(classifyExchangeRateApiResponse(404, success, [])).toMatchObject({ outcome: 'DEFINITIVE', providerErrorCode: 'http-404' });
    expect(classifyExchangeRateApiResponse(200, success, [])).toMatchObject({ outcome: 'OK' });
    expect(failureKindOf(null)).toBe(FetchFailureKind.REQUEST_REJECTED);
  });
});
