import * as dotenv from 'dotenv';

dotenv.config();

import { ProviderCallRecord, ProviderCallRecorder } from '../src/common/http/provider-call-recorder';
import { ProviderHttpClient } from '../src/common/http/provider-http-client';
import { dec } from '../src/common/money';
import { ExchangeRateApiProvider } from '../src/modules/fx/providers/exchange-rate-api.provider';
import { freshnessOf } from '../src/modules/fx/freshness';
import { PROVIDER_PLAN_PROFILES, ProviderPlan } from '../src/modules/fx/provider-plan';
import { checkSanity } from '../src/modules/fx/rate-sanity';

const DEFAULT_BOUNDS: Record<string, [string, string]> = { USD: ['1', '1'], NGN: ['100', '100000'], EUR: ['0.1', '10'], GBP: ['0.1', '10'] };

/**
 * Manual smoke test against the REAL provider (never run in CI): one request through the
 * real adapter, parser and sanity checks, using `FX_RATE_BASE_URL` (default: the open
 * endpoint), `FX_PROVIDER_PLAN` and `EXCHANGE_RATE_API_KEY` (keyed URLs only) from the
 * environment. Prints what was read; records nothing. Needs no database or other secret.
 *
 *   npm run fx:smoke
 */
async function main(): Promise<void> {
  const plan = (process.env.FX_PROVIDER_PLAN ?? ProviderPlan.OPEN) as ProviderPlan;
  const profile = PROVIDER_PLAN_PROFILES[plan];
  const fx = {
    providerName: 'exchange-rate-api',
    baseUrl: (process.env.FX_RATE_BASE_URL ?? 'https://open.er-api.com/v6/latest').replace(/\/+$/, ''),
    apiKey: process.env.EXCHANGE_RATE_API_KEY || undefined,
    requestTimeoutMilliseconds: 5000,
    ...profile,
  };
  const calls: ProviderCallRecord[] = [];
  const recorder = { recordQuietly: async (call: ProviderCallRecord) => void calls.push(call) } as unknown as ProviderCallRecorder;
  const client = new ProviderHttpClient(
    {
      provider: fx.providerName,
      label: 'ExchangeRate-API',
      baseUrl: new URL(fx.baseUrl.split('{apiKey}').join('key')).origin,
      timeoutMilliseconds: fx.requestTimeoutMilliseconds,
      readRetries: 0,
      secrets: fx.apiKey ? [fx.apiKey] : [],
      recordResponseAs: 'raw-json-text',
    },
    recorder,
  );
  const provider = new ExchangeRateApiProvider({ name: fx.providerName, baseUrl: fx.baseUrl, apiKey: fx.apiKey }, client);
  const known = ['USD', 'NGN', 'EUR', 'GBP'];
  const result = await provider.fetchLatest({ knownCurrencies: known });
  process.stdout.write(`request: ${calls[0]?.requestMethod} ${calls[0]?.requestPath} → HTTP ${calls[0]?.responseStatus ?? '-'}\n`);
  if (result.kind === 'FAILURE') {
    process.stdout.write(`FAILED: ${result.failure} ${result.providerErrorCode ?? ''} ${result.detail}\n`);
    process.exitCode = 1;
    return;
  }
  const now = new Date();
  const verdict = checkSanity(result.rates, {
    now,
    activeCurrencies: known,
    bounds: new Map(Object.entries(DEFAULT_BOUNDS).map(([code, [minimum, maximum]]) => [code, { minimum: dec(minimum), maximum: dec(maximum) }])),
    maximumJumpRatio: dec('0.20'),
    jumpRatioOverrides: new Map(),
    cadenceSeconds: fx.cadenceSeconds,
  });
  const freshness = freshnessOf(result.rates, now, {
    executableMaximumAgeSeconds: fx.executableMaximumAgeSeconds,
    displayMaximumAgeSeconds: fx.displayMaximumAgeSeconds,
    publicationGraceSeconds: fx.publicationGraceSeconds,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        plan: fx.plan,
        base: result.rates.baseCurrency,
        providerUpdatedAt: result.rates.providerUpdatedAt.toISOString(),
        providerNextUpdateAt: result.rates.providerNextUpdateAt.toISOString(),
        rates: Object.fromEntries([...result.rates.rates].map(([code, rate]) => [code, rate.toFixed()])),
        sanity: verdict.accepted ? 'ACCEPTED' : { rejected: verdict.reasons },
        tier: freshness.tier,
        rateAgeSeconds: Math.ceil(freshness.ageMilliseconds / 1000),
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
