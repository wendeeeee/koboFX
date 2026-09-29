import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { TestClock } from '../support/auth-test-doubles';
import { FxHarness, LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

/**
 * Redis down (design §16: "rates fall back to DB snapshots"; Phase 6 §5.10): reads are served
 * from the latest database snapshot, and NO provider call is made at all — without Redis
 * neither the fetch lock nor the request budget can be enforced, so the quota fails closed.
 */
describe('FX with Redis down (integration)', () => {
  let harness: LedgerHarness;
  let fx: FxHarness;
  let payments: PaymentsHarness;
  let clock: TestClock;
  let user: SignedUpUser;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { fx: true });
    fx = harness.fx!;
    payments = harness.payments!;
    clock = harness.auth!.clock;
    user = await payments.signUp();
    await fx.warm();
    await harness.auth!.redis.stop();
  });
  afterAll(() => harness?.close());

  const http = () => request(harness.auth!.app.getHttpServer());

  it('GET /fx/rates is served from the database snapshot, with its true age', async () => {
    const response = await http().get(`/${API_PREFIX}/fx/rates`).set('Authorization', `Bearer ${user.accessToken}`).expect(200);
    expect(response.body).toMatchObject({ stale: false, rateAgeSeconds: 60 });
    expect((await fx.rates.current())!.source).toBe('DATABASE');
  });

  it('a quote still prices from the executable database snapshot (the barrier is database-only)', async () => {
    const response = await fx.quote(user, { from: 'NGN', to: 'USD', sourceAmount: '1000000' });
    expect(response.status).toBe(201);
  });

  it('the poller makes no provider call (fail closed on the quota), and nothing is written', async () => {
    clock.advance(400_000);
    const requests = fx.api.requests;
    expect(await fx.poller.tick()).toMatchObject({ fetched: true, outcome: { kind: 'SKIPPED', reason: 'REDIS_UNAVAILABLE' } });
    expect(fx.api.requests).toBe(requests);
  });

  it('too old and Redis down → 503 FX_RATE_UNAVAILABLE, still without a provider call; readiness reports FX without failing on it', async () => {
    clock.advance(450_000); // rate age 910s (> 900s display window); the access token is 850s old, still valid — and with Redis down no new one can be issued
    const requests = fx.api.requests;
    const response = await http().get(`/${API_PREFIX}/fx/rates`).set('Authorization', `Bearer ${user.accessToken}`);
    expect([response.status, response.body.code]).toEqual([503, 'FX_RATE_UNAVAILABLE']);
    expect(fx.api.requests).toBe(requests);
    const ready = await http().get(`/${API_PREFIX}/health/ready`);
    // Readiness fails on Redis (unchanged since Phase 4), and reports the FX tier alongside.
    expect(ready.status).toBe(503);
    expect(ready.body.fx).toMatchObject({ tier: 'UNSERVABLE', provider: 'exchange-rate-api' });
  });
});
