import { Writable } from 'node:stream';
import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { RECORDED_RATES } from '../../src/mock-exchange-rate-api/mock-exchange-rate-api';
import { RateTier } from '../../src/modules/fx/freshness';
import { SNAPSHOT_CACHE_KEY } from '../../src/modules/fx/rate-cache';
import { RedisService } from '../../src/redis/redis.service';
import { TestClock } from '../support/auth-test-doubles';
import { FxHarness, LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

/** Captures every log line of the run (log hygiene: the API key travels in the URL path). */
class LogCapture extends Writable {
  readonly lines: string[] = [];
  override _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.lines.push(chunk.toString('utf8'));
    callback();
  }
}

/**
 * The FX rate pipeline and read path (design §7.4; PHASE6_PLAN §D), end to end against real
 * Postgres and Redis and the simulated ExchangeRate-API (keyed, Business plan: executable
 * while ≤ 420s old and current, displayable to 900s).
 */
describe('FX rates: poller, cache, read path (integration)', () => {
  const logs = new LogCapture();
  let harness: LedgerHarness;
  let fx: FxHarness;
  let payments: PaymentsHarness;
  let clock: TestClock;
  let user: SignedUpUser;

  beforeAll(async () => {
    harness = await startLedgerHarness({ LOG_LEVEL: 'info' }, { fx: true, logStream: logs });
    fx = harness.fx!;
    payments = harness.payments!;
    clock = harness.auth!.clock;
    user = await payments.signUp();
  });
  afterAll(() => harness?.close());
  beforeEach(async () => {
    // Time only moves forward (as it does in production): each test starts a day later, so
    // snapshots stored by earlier tests are simply older ones.
    clock.advance(86_400_000);
    // A day later the access token has (correctly) expired: a fresh verified user per test.
    user = await payments.signUp();
    fx.api.clearFaults();
    await fx.resetRedisState();
    await payments.clearRateLimits();
  });

  const http = () => request(harness.auth!.app.getHttpServer());
  const getRates = () => http().get(`/${API_PREFIX}/fx/rates`).set('Authorization', `Bearer ${user.accessToken}`);
  const snapshotCount = async (status?: string) =>
    ((await harness.dataSource.query(
      `SELECT count(*)::int AS n FROM exchange_rate_snapshots ${status ? 'WHERE status = $1' : ''}`,
      status ? [status] : [],
    )) as { n: number }[])[0].n;
  const cached = async () => fx.rates['cache'].read();

  describe('the poller', () => {
    it('provider OK → an ACCEPTED snapshot in Postgres AND the same snapshot in Redis, with provenance', async () => {
      fx.publishFresh({ ...RECORDED_RATES, NGN: '1530.123456789012345' });
      const before = await snapshotCount('ACCEPTED');
      const result = await fx.poller.tick();
      expect(result).toMatchObject({ fetched: true, outcome: { kind: 'ACCEPTED' } });
      expect(await snapshotCount('ACCEPTED')).toBe(before + 1);
      const inRedis = await cached();
      const [row] = (await harness.dataSource.query(
        `SELECT s.id, s.provider, s.provider_call_id IS NOT NULL AS linked, r.rate::text AS ngn
           FROM exchange_rate_snapshots s JOIN exchange_rate_snapshot_rates r ON r.snapshot_id = s.id AND r.currency_code = 'NGN'
          WHERE s.status = 'ACCEPTED' ORDER BY s.fetched_at DESC, s.id DESC LIMIT 1`,
      )) as { id: string; provider: string; linked: boolean; ngn: string }[];
      expect(row).toEqual({ id: inRedis!.id, provider: 'exchange-rate-api', linked: true, ngn: '1530.123456789012345' });
      expect(inRedis!.rates.get('NGN')!.toFixed()).toBe('1530.123456789012345');
      // The evidence keeps every digit of the response (raw text → JSONB → NUMERIC).
      const [evidence] = (await harness.dataSource.query(
        `SELECT response_body -> 'conversion_rates' ->> 'NGN' AS ngn FROM provider_calls p
           JOIN exchange_rate_snapshots s ON s.provider_call_id = p.id WHERE s.id = $1`,
        [row.id],
      )) as { ngn: string }[];
      expect(evidence.ngn).toBe('1530.123456789012345');
    });

    it('is quota-aware: not due again until just after the announced next publication', async () => {
      await fx.warm();
      const requests = fx.api.requests;
      expect(await fx.poller.tick()).toMatchObject({ fetched: false });
      clock.advance(200_000);
      expect(await fx.poller.tick()).toMatchObject({ fetched: false });
      clock.advance(300_000); // past next update (300s) + jitter (≤ 90s)
      fx.publishFresh();
      expect(await fx.poller.tick()).toMatchObject({ fetched: true, outcome: { kind: 'ACCEPTED' } });
      expect(fx.api.requests - requests).toBe(1);
    });

    it.each([
      ['provider down (5xx × 4)', () => fx.api.failNext(...Array.from({ length: 4 }, () => ({ kind: 'server-error' as const }))), 'TRANSIENT', 4],
      ['quota-reached', () => fx.api.failNext({ kind: 'error-type', errorType: 'quota-reached', status: 200 }), 'QUOTA_REACHED', 1],
      ['invalid-key (HTTP 403)', () => fx.api.failNext({ kind: 'error-type', errorType: 'invalid-key', status: 403 }), 'CREDENTIALS_REJECTED', 1],
      ['inactive-account', () => fx.api.failNext({ kind: 'error-type', errorType: 'inactive-account', status: 200 }), 'CREDENTIALS_REJECTED', 1],
      ['garbage × 4', () => fx.api.failNext(...Array.from({ length: 4 }, () => ({ kind: 'garbage' as const }))), 'INVALID_RESPONSE', 4],
    ])('%s → nothing written but the evidence, last known kept and ageing honestly, breaker open', async (_name, fault, failure, calls) => {
      await fx.warm();
      const lastKnown = await fx.rates.current();
      const snapshotsBefore = await snapshotCount();
      const callsBefore = await fx.providerCallCount();
      fault();
      clock.advance(400_000); // due
      expect(await fx.poller.tick()).toMatchObject({ fetched: true, outcome: { kind: 'FAILED', failure } });
      expect(await snapshotCount()).toBe(snapshotsBefore);
      expect((await fx.providerCallCount()) - callsBefore).toBe(calls);
      const after = await fx.rates.current();
      expect(after!.snapshot.id).toBe(lastKnown!.snapshot.id);
      expect(after!.freshness.tier).toBe(RateTier.DISPLAY_ONLY);
      expect(after!.freshness.ageMilliseconds).toBe(460_000);
      // Breaker open: the next tick makes no call at all.
      const requests = fx.api.requests;
      expect(await fx.poller.tick()).toMatchObject({ fetched: true, outcome: { kind: 'SKIPPED', reason: 'BACKING_OFF' } });
      expect(fx.api.requests).toBe(requests);
    });

    it('a stale provider time is stored truthfully and served as what it is: display-only, never executable', async () => {
      fx.publishFresh(RECORDED_RATES, { publishedSecondsAgo: 600, nextUpdateInSeconds: -300 });
      expect(await fx.poller.tick()).toMatchObject({ fetched: true, outcome: { kind: 'ACCEPTED' } });
      const served = await fx.rates.current();
      expect(served!.freshness).toMatchObject({ tier: RateTier.DISPLAY_ONLY, isCurrentPublication: false });
    });

    it('a > 20% jump is REJECTED: stored as evidence, alerted, never cached or served', async () => {
      await fx.warm();
      const lastKnown = (await cached())!.id;
      const rejectedBefore = await snapshotCount('REJECTED');
      clock.advance(400_000);
      fx.publishFresh({ ...RECORDED_RATES, NGN: '1700' }); // +27.9%
      expect(await fx.poller.tick()).toMatchObject({ fetched: true, outcome: { kind: 'REJECTED', reasons: ['RATE_JUMP:NGN'] } });
      expect(await snapshotCount('REJECTED')).toBe(rejectedBefore + 1);
      expect((await cached())!.id).toBe(lastKnown);
      expect((await fx.rates.current())!.snapshot.id).toBe(lastKnown);
      expect(fx.metrics.deviationRatios().NGN).toMatch(/^0\.27/);
      expect(logs.lines.some((line) => line.includes('RATE_JUMP:NGN') && line.includes('"alert":true'))).toBe(true);
    });

    it('the API key never reaches provider_calls (any column), an error text or a log line', async () => {
      // Self-contained: a success, a timeout (whose error text could echo the URL) and a 5xx — all recorded now.
      await fx.warm();
      const [{ since }] = (await harness.dataSource.query(`SELECT coalesce(max(id), 0)::text AS since FROM provider_calls`)) as { since: string }[];
      fx.api.failNext({ kind: 'hang', milliseconds: 1_000 }, { kind: 'server-error' });
      clock.advance(400_000);
      fx.publishFresh();
      expect(await fx.poller.tick()).toMatchObject({ fetched: true, outcome: { kind: 'ACCEPTED' } });
      const [row] = (await harness.dataSource.query(
        `SELECT count(*)::int AS n, string_agg(p::text, '\n') AS everything FROM provider_calls p WHERE provider = 'exchange-rate-api' AND id > $1`,
        [since],
      )) as { n: number; everything: string }[];
      expect(row.n).toBe(3);
      expect(row.everything).toMatch(/timed out/);
      expect(row.everything).toContain('[REDACTED]');
      expect(row.everything).not.toContain(fx.apiKey);
      expect(logs.lines.join('')).not.toContain(fx.apiKey);
    });
  });

  describe('the read path through every tier (TestClock)', () => {
    it('fresh → EXECUTABLE from Redis; GET /fx/rates states provider, asOf, true age, stale:false, attribution', async () => {
      await fx.warm();
      const response = await getRates().expect(200);
      expect(response.body).toMatchObject({
        provider: 'exchange-rate-api',
        rateAgeSeconds: 60,
        stale: false,
        attribution: { text: 'Rates By Exchange Rate API', url: 'https://www.exchangerate-api.com' },
      });
      expect(response.body.pairs).toHaveLength(12);
      expect(response.body.pairs).toContainEqual({
        from: 'NGN',
        to: 'USD',
        midRate: '0.000752232677928',
        clientRate: '0.000740949187759',
        spreadBasisPoints: 150,
        minimumSourceAmount: '100000',
      });
      expect((await fx.rates.current())!.source).toBe('REDIS');
    });

    it('stale but displayable → stale:true, true age; execution → 503 FX_RATE_STALE with Retry-After', async () => {
      await fx.warm();
      clock.advance(361_000); // age 421s > 420s
      const response = await getRates().expect(200);
      expect(response.body).toMatchObject({ stale: true, rateAgeSeconds: 421 });
      const quote = await fx.quote(user, { from: 'NGN', to: 'USD', sourceAmount: '1000000' });
      expect(quote.status).toBe(503);
      expect(quote.body.code).toBe('FX_RATE_STALE');
      expect(Number(quote.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('cold cache (Redis flushed) → served from the database snapshot, no provider call; the poller re-seeds Redis', async () => {
      await fx.warm();
      await fx.flushSnapshotCache();
      const requests = fx.api.requests;
      await getRates().expect(200);
      expect((await fx.rates.current())!.source).toBe('DATABASE');
      expect(fx.api.requests).toBe(requests);
      expect(await fx.poller.tick()).toMatchObject({ reseeded: true, fetched: false });
      expect((await harness.moduleRef.get(RedisService).evaluate(`return redis.call('EXISTS', KEYS[1])`, [SNAPSHOT_CACHE_KEY], []))).toBe(1);
      expect(fx.api.requests).toBe(requests);
    });

    it('too old to display → ONE synchronous catch-up fetch, then fresh', async () => {
      await fx.warm();
      clock.advance(901_000);
      user = await payments.signUp(); // the 900s access token expired with the jump
      expect((await fx.rates.current())!.freshness.tier).toBe(RateTier.UNSERVABLE);
      fx.publishFresh();
      const requests = fx.api.requests;
      const response = await getRates().expect(200);
      expect(response.body.stale).toBe(false);
      expect(fx.api.requests - requests).toBe(1);
    });

    it('everything down and too old → 503 FX_RATE_UNAVAILABLE (and only one catch-up attempt a minute)', async () => {
      await fx.warm();
      clock.advance(901_000);
      user = await payments.signUp(); // the 900s access token expired with the jump
      fx.api.failNext(...Array.from({ length: 10 }, () => ({ kind: 'server-error' as const })));
      const requests = fx.api.requests;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await getRates();
        expect(response.status).toBe(503);
        expect(response.body.code).toBe('FX_RATE_UNAVAILABLE');
      }
      expect(fx.api.requests - requests).toBe(1);
    });
  });

  describe('the cache protects the quota', () => {
    it('1,000 GET /fx/rates and quote requests with a warm cache cause ZERO provider calls', async () => {
      await fx.warm();
      const requests = fx.api.requests;
      const calls = await fx.providerCallCount();
      let quotes = 0;
      for (let batch = 0; batch < 20; batch += 1) {
        await payments.clearRateLimits();
        const responses = await Promise.all(
          Array.from({ length: 50 }, (_, index) =>
            index % 2 === 0 ? getRates() : fx.quote(user, { from: 'NGN', to: 'USD', sourceAmount: String(1_000_000 + batch * 50 + index) }),
          ),
        );
        for (const response of responses) expect([200, 201]).toContain(response.status);
        quotes += responses.filter((response) => response.status === 201).length;
        clock.advance(1_000); // time passes, still executable (≤ 420s)
      }
      expect(quotes).toBe(500);
      expect(fx.api.requests).toBe(requests);
      expect(await fx.providerCallCount()).toBe(calls);
    });
  });

  describe('the cache never goes backwards', () => {
    it('an older snapshot offered after a newer one (a slow fetcher, a late re-seed) is refused', async () => {
      await fx.warm();
      const older = (await cached())!;
      clock.advance(400_000);
      await fx.warm();
      const newer = (await cached())!;
      expect(newer.id).not.toBe(older.id);
      const cache = fx.rates['cache'];
      expect(await cache.offer(older, 3_600)).toBe(false);
      expect((await cached())!.id).toBe(newer.id);
    });
  });

  describe('a provider stuck publishing old data', () => {
    it('succeeds with an unservable rate: the catch-up gate still limits it to one call a minute', async () => {
      await fx.warm();
      clock.advance(901_000);
      user = await payments.signUp(); // the 900s access token expired with the jump
      // A plausible but old publication: accepted (it is what they publish), never displayable.
      fx.publishFresh(RECORDED_RATES, { publishedSecondsAgo: 1_000, nextUpdateInSeconds: -500 });
      const requests = fx.api.requests;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await getRates();
        expect([response.status, response.body.code]).toEqual([503, 'FX_RATE_UNAVAILABLE']);
      }
      // A success closes the breaker, so only the gate stands between user traffic and the provider.
      expect(await fx.coordination.backoff()).toBeUndefined();
      expect(fx.api.requests - requests).toBe(1);
      clock.advance(61_000);
      await getRates();
      expect(fx.api.requests - requests).toBe(2);
    });
  });

  describe('single flight and the breaker', () => {
    it('50 concurrent cache misses → exactly one provider call; every loser gets the winner\'s rate', async () => {
      await fx.warm();
      clock.advance(901_000); // nothing displayable
      user = await payments.signUp(); // the 900s access token expired with the jump
      fx.publishFresh();
      fx.api.failNext({ kind: 'hang', milliseconds: 250 }); // widen the race window
      const requests = fx.api.requests;
      const responses = await Promise.all(Array.from({ length: 50 }, () => getRates()));
      expect(responses.map((response) => response.status)).toEqual(Array.from({ length: 50 }, () => 200));
      expect(new Set(responses.map((response) => response.body.asOf)).size).toBe(1);
      expect(fx.api.requests - requests).toBe(1);
    });

    it('…and when the winner fails, every loser gets a clean 503 — still one call', async () => {
      await fx.warm();
      clock.advance(901_000);
      user = await payments.signUp(); // the 900s access token expired with the jump
      // Longer than the client's per-attempt timeout (400ms in tests): the single catch-up attempt fails.
      fx.api.failNext({ kind: 'hang', milliseconds: 1_000 }, ...Array.from({ length: 5 }, () => ({ kind: 'server-error' as const })));
      const requests = fx.api.requests;
      const responses = await Promise.all(Array.from({ length: 50 }, () => getRates()));
      expect(responses.map((response) => [response.status, response.body.code])).toEqual(Array.from({ length: 50 }, () => [503, 'FX_RATE_UNAVAILABLE']));
      expect(fx.api.requests - requests).toBe(1);
    });

    it('the breaker opens after a failure, fails fast, half-opens after the backoff and closes on success', async () => {
      await fx.warm();
      clock.advance(400_000);
      fx.api.failNext(...Array.from({ length: 4 }, () => ({ kind: 'server-error' as const })));
      expect((await fx.fetcher.fetch('POLL')).kind).toBe('FAILED');
      const state = await fx.coordination.backoff();
      expect(state).toMatchObject({ kind: 'TRANSIENT', consecutiveFailures: 1 });
      const requests = fx.api.requests;
      expect(await fx.fetcher.fetch('POLL')).toEqual({ kind: 'SKIPPED', reason: 'BACKING_OFF' }); // fail fast
      expect(fx.api.requests).toBe(requests);
      clock.advance(61_000); // half-open
      fx.publishFresh();
      expect((await fx.fetcher.fetch('POLL')).kind).toBe('ACCEPTED');
      expect(fx.api.requests - requests).toBe(1);
      expect(await fx.coordination.backoff()).toBeUndefined(); // closed
    });
  });
});
