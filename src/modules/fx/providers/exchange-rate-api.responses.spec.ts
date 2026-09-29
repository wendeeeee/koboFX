import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ParsedRates, parseLatestResponse, rateFromText } from './exchange-rate-api.responses';

const FIXTURES = join(__dirname, '../../../../test/fixtures/exchange-rate-api');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const KNOWN = ['NGN', 'USD', 'EUR', 'GBP'];

function success(rates: string, extra = ''): string {
  return `{"result":"success","time_last_update_unix":1790640151,"time_next_update_unix":1790726941,"base_code":"USD",${extra}"conversion_rates":${rates}}`;
}

function asRates(parsed: ReturnType<typeof parseLatestResponse>): ParsedRates {
  if (parsed.kind !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${JSON.stringify(parsed)}`);
  return parsed;
}

describe('ExchangeRate-API responses — contract (recorded fixtures, design §11)', () => {
  it('reads the recorded open-access response (field `rates`): NGN, USD, EUR, GBP present, exact digits', () => {
    const parsed = asRates(parseLatestResponse(fixture('open-latest-usd.recorded-2026-09-29.json'), KNOWN));
    expect(parsed.baseCurrency).toBe('USD');
    expect(parsed.providerUpdatedAt.toISOString()).toBe('2026-09-29T00:02:31.000Z');
    expect(parsed.providerNextUpdateAt.toISOString()).toBe('2026-09-30T00:09:01.000Z');
    expect(Object.fromEntries([...parsed.rates].map(([code, rate]) => [code, rate.toFixed()]))).toEqual({
      NGN: '1329.375909',
      USD: '1',
      EUR: '0.879241',
      GBP: '0.754467',
    });
    expect(parsed.malformedRates).toEqual([]);
  });

  it('reads the keyed v6 shape (field `conversion_rates`) identically', () => {
    const parsed = asRates(parseLatestResponse(fixture('v6-latest-usd.constructed-2026-09-29.json'), KNOWN));
    expect(parsed.rates.get('NGN')?.toFixed()).toBe('1329.375909');
    expect(parsed.rates.size).toBe(4);
  });

  it('reads the recorded invalid-key error body (sent with HTTP 403; note `terms-of-use` with hyphens)', () => {
    expect(parseLatestResponse(fixture('v6-invalid-key.recorded-2026-09-29.http-403.json'), KNOWN)).toEqual({ kind: 'ERROR', errorType: 'invalid-key' });
    for (const errorType of ['unsupported-code', 'malformed-request', 'inactive-account', 'quota-reached', 'something-new']) {
      expect(parseLatestResponse(`{"result":"error","error-type":"${errorType}"}`, KNOWN)).toEqual({ kind: 'ERROR', errorType });
    }
  });
});

describe('parsing without a float (Phase 6 §5.6)', () => {
  it('a rate survives exactly, digit for digit, beyond double precision', () => {
    const parsed = asRates(parseLatestResponse(success('{"USD":1,"NGN":1530.123456789012345,"EUR":0.87924100000000000001}'), KNOWN));
    expect(parsed.rates.get('NGN')?.toFixed()).toBe('1530.123456789012345');
    expect(parsed.rates.get('EUR')?.toFixed()).toBe('0.87924100000000000001');
    // What JSON.parse would have done:
    expect(String(JSON.parse('1530.123456789012345'))).toBe('1530.1234567890124');
  });

  it('exponent notation is converted exactly; zero and negative are kept for the sanity checks to reject', () => {
    const parsed = asRates(parseLatestResponse(success('{"USD":1,"NGN":1.2e-5,"EUR":0,"GBP":-0.75}'), KNOWN));
    expect(parsed.rates.get('NGN')?.toFixed()).toBe('0.000012');
    expect(parsed.rates.get('EUR')?.toFixed()).toBe('0');
    expect(parsed.rates.get('GBP')?.toFixed()).toBe('-0.75');
    expect(rateFromText('1E+3')?.toFixed()).toBe('1000');
  });

  it('absurd numbers are malformed, not expanded', () => {
    expect(rateFromText('1e999999999')).toBeUndefined();
    expect(rateFromText('1'.repeat(41))).toBeUndefined();
    expect(rateFromText('01.5')).toBeUndefined();
    const parsed = asRates(parseLatestResponse(success('{"USD":1,"NGN":1e400,"EUR":"0.87","GBP":null}'), KNOWN));
    expect(parsed.malformedRates).toEqual(['NGN', 'EUR', 'GBP']);
  });
});

describe('only the fields we use are validated (design §7.2 point 1)', () => {
  it('extra fields and currencies we do not use are ignored; a missing known currency is simply absent', () => {
    const parsed = asRates(
      parseLatestResponse(success('{"USD":1,"NGN":1329.1,"XYZ":"garbage","JPY":"also garbage"}', '"time_eol_unix":0,"surprise":{"nested":[1,2]},'), KNOWN),
    );
    expect([...parsed.rates.keys()]).toEqual(['NGN', 'USD']);
    expect(parsed.malformedRates).toEqual([]);
  });

  it.each([
    ['not JSON', 'not json at all'],
    ['a JSON array', '[1,2]'],
    ['no result', '{"base_code":"USD"}'],
    ['result neither success nor error', '{"result":"maybe"}'],
    ['missing base_code', '{"result":"success","time_last_update_unix":1,"time_next_update_unix":2,"rates":{}}'],
    ['timestamps as strings', '{"result":"success","base_code":"USD","time_last_update_unix":"1","time_next_update_unix":2,"rates":{}}'],
    ['fractional timestamps', '{"result":"success","base_code":"USD","time_last_update_unix":1.5,"time_next_update_unix":2,"rates":{}}'],
    ['no rate table', '{"result":"success","base_code":"USD","time_last_update_unix":1,"time_next_update_unix":2}'],
    ['both rate tables', '{"result":"success","base_code":"USD","time_last_update_unix":1,"time_next_update_unix":2,"rates":{},"conversion_rates":{}}'],
    ['a rate table that is not an object', '{"result":"success","base_code":"USD","time_last_update_unix":1,"time_next_update_unix":2,"rates":[1]}'],
    ['an error without error-type', '{"result":"error"}'],
  ])('a structurally broken response is INVALID: %s', (_name, text) => {
    expect(parseLatestResponse(text, KNOWN).kind).toBe('INVALID');
  });
});
