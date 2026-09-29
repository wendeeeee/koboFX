import 'dotenv/config';
import { MockExchangeRateApi, RECORDED_RATES } from './mock-exchange-rate-api';

/**
 * Runs the simulated ExchangeRate-API for local development (`npm run start:mock-fx:dev`).
 * Point the app at it with `FX_RATE_BASE_URL=http://localhost:4020/v6/latest`. It publishes
 * the rates recorded on 2026-09-29 and "republishes" them every `MOCK_FX_CADENCE_SECONDS`
 * (default 300, the Business plan's cadence), so the poller's schedule can be watched.
 */
async function main(): Promise<void> {
  const port = Number(process.env.MOCK_FX_PORT ?? '4020');
  const cadenceSeconds = Number(process.env.MOCK_FX_CADENCE_SECONDS ?? '300');
  const api = new MockExchangeRateApi({ apiKey: process.env.EXCHANGE_RATE_API_KEY });
  const republish = () => {
    const now = Date.now();
    api.publish({ rates: RECORDED_RATES, publishedAt: new Date(now), nextUpdateAt: new Date(now + cadenceSeconds * 1000) });
  };
  republish();
  const timer = setInterval(republish, cadenceSeconds * 1000);
  const url = await api.start(port, '0.0.0.0');
  process.stdout.write(`Simulated ExchangeRate-API listening on ${url} (open: /v6/latest/USD, keyed: /v6/{key}/latest/USD)\n`);
  const shutdown = () => {
    clearInterval(timer);
    void api.stop().then(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
