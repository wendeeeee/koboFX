import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { DomainError, ErrorCode } from '../../src/common/errors';
import { RoundingPolicy, dec } from '../../src/common/money';
import { RECORDED_RATES } from '../../src/mock-exchange-rate-api/mock-exchange-rate-api';
import { QuoteAmountMode, priceConversion } from '../../src/modules/fx/pricing';
import { TestClock } from '../support/auth-test-doubles';
import { FxHarness, LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

/**
 * Quotes (design §7.7; PHASE6_PLAN §E): created only with an executable rate, locking every
 * amount Phase 7 posts; scoped by user; 30s; idempotent creation; and the tested
 * `consume(quoteId, userId)` primitive.
 */
describe('FX quotes (integration)', () => {
  let harness: LedgerHarness;
  let fx: FxHarness;
  let payments: PaymentsHarness;
  let clock: TestClock;
  let alice: SignedUpUser;
  let bob: SignedUpUser;
  let owner: Client;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { fx: true });
    fx = harness.fx!;
    payments = harness.payments!;
    clock = harness.auth!.clock;
    owner = await harness.db.ownerClient();
    alice = await payments.signUp();
    bob = await payments.signUp();
  });
  afterAll(async () => {
    await owner?.end();
    await harness?.close();
  });
  beforeEach(async () => {
    clock.advance(86_400_000);
    fx.api.clearFaults();
    await fx.resetRedisState();
    await payments.clearRateLimits();
    await fx.warm();
  });

  const http = () => request(harness.auth!.app.getHttpServer());
  const getQuote = (user: SignedUpUser, quoteId: string) =>
    http().get(`/${API_PREFIX}/fx/quotes/${quoteId}`).set('Authorization', `Bearer ${user.accessToken}`);
  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return 'SUCCEEDED';
    } catch (error) {
      return error instanceof DomainError ? error.code : String(error);
    }
  };
  const quoteRow = async (quoteId: string) =>
    ((await harness.dataSource.query(
      `SELECT source_amount_minor::text AS source, target_amount_minor::text AS target, target_mid_value_minor::text AS mid,
              revenue_minor::text AS revenue, spread_basis_points, rate_snapshot_id, source_reference_rate::text AS source_rate,
              target_reference_rate::text AS target_rate, consumed_at
         FROM quotes WHERE id = $1`,
      [quoteId],
    )) as { source: string; target: string; mid: string; revenue: string; spread_basis_points: number; rate_snapshot_id: string; source_rate: string; target_rate: string; consumed_at: Date | null }[])[0];

  it('prices from the executable snapshot and locks the exact amounts Phase 7 will post (§5.6)', async () => {
    const response = await fx.quote(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000000' }).expect(201);
    const expected = priceConversion(
      { source: { code: 'NGN', minorUnit: 2 }, target: { code: 'USD', minorUnit: 2 }, sourceUsdRate: dec(RECORDED_RATES.NGN), targetUsdRate: dec('1'), spreadBasisPoints: 150, mode: QuoteAmountMode.SOURCE, amountMinor: 100_000_000n },
      harness.moduleRef.get(RoundingPolicy),
    );
    expect(response.body).toMatchObject({
      from: 'NGN',
      to: 'USD',
      amountMode: 'SOURCE',
      sourceAmount: '100000000',
      targetAmount: expected.targetAmountMinor.toString(),
      midRate: '0.000752232677928',
      clientRate: '0.000740949187759',
      spreadBasisPoints: 150,
      status: 'OPEN',
      rate: { provider: 'exchange-rate-api' },
    });
    expect(Date.parse(response.body.expiresAt) - Date.parse(response.body.issuedAt)).toBe(30_000);
    // The revenue and mid value are ours: locked in the row, never on the wire.
    expect(response.body).not.toHaveProperty('revenue');
    const row = await quoteRow(response.body.quoteId);
    expect(row).toMatchObject({
      source: '100000000',
      target: expected.targetAmountMinor.toString(),
      mid: expected.targetMidValueMinor.toString(),
      revenue: expected.revenueMinor.toString(),
      spread_basis_points: 150,
      rate_snapshot_id: response.body.rate.snapshotId,
      source_rate: '1329.375909',
      target_rate: '1',
      consumed_at: null,
    });
  });

  it('TARGET mode: "buy $50 with NGN" debits the rounded-up source', async () => {
    const response = await fx.quote(alice, { from: 'NGN', to: 'USD', targetAmount: '5000' }).expect(201);
    expect(response.body).toMatchObject({ amountMode: 'TARGET', targetAmount: '5000', sourceAmount: '6748102' });
  });

  it.each([
    ['same currency', { from: 'NGN', to: 'NGN', sourceAmount: '100000' }, 400, 'SAME_CURRENCY'],
    ['unknown currency', { from: 'NGN', to: 'XYZ', sourceAmount: '100000' }, 400, 'UNSUPPORTED_CURRENCY'],
    ['both amounts', { from: 'NGN', to: 'USD', sourceAmount: '100000', targetAmount: '100' }, 400, 'VALIDATION_FAILED'],
    ['neither amount', { from: 'NGN', to: 'USD' }, 400, 'VALIDATION_FAILED'],
    ['a JSON number amount', { from: 'NGN', to: 'USD', sourceAmount: 100000 }, 400, 'VALIDATION_FAILED'],
    ['below the pair minimum (₦1,000)', { from: 'NGN', to: 'USD', sourceAmount: '99999' }, 422, 'AMOUNT_TOO_SMALL'],
  ])('refuses %s', async (_name, body, status, code) => {
    const response = await fx.quote(alice, body);
    expect([response.status, response.body.code]).toEqual([status, code]);
  });

  it('refuses a pair that is not active (UNSUPPORTED_CURRENCY_PAIR)', async () => {
    await owner.query(`UPDATE currency_pairs SET is_active = FALSE WHERE source_currency_code = 'EUR' AND target_currency_code = 'GBP'`);
    try {
      const response = await fx.quote(alice, { from: 'EUR', to: 'GBP', sourceAmount: '10000' });
      expect([response.status, response.body.code]).toEqual([400, 'UNSUPPORTED_CURRENCY_PAIR']);
    } finally {
      await owner.query(`UPDATE currency_pairs SET is_active = TRUE WHERE source_currency_code = 'EUR' AND target_currency_code = 'GBP'`);
    }
  });

  it('GET is scoped by user: the owner sees it; anyone else gets 404 QUOTE_NOT_FOUND (never 403)', async () => {
    const created = await fx.quote(alice, { from: 'USD', to: 'NGN', sourceAmount: '10000' }).expect(201);
    const mine = await getQuote(alice, created.body.quoteId).expect(200);
    expect(mine.body).toEqual(created.body);
    const theirs = await getQuote(bob, created.body.quoteId);
    expect([theirs.status, theirs.body.code]).toEqual([404, 'QUOTE_NOT_FOUND']);
    const missing = await getQuote(alice, randomUUID());
    expect([missing.status, missing.body.code]).toEqual([404, 'QUOTE_NOT_FOUND']);
  });

  it('expires at 30s on the clock: OPEN at 29.999s, EXPIRED at 30s', async () => {
    const created = await fx.quote(alice, { from: 'USD', to: 'NGN', sourceAmount: '10000' }).expect(201);
    clock.advance(29_999);
    expect((await getQuote(alice, created.body.quoteId).expect(200)).body.status).toBe('OPEN');
    clock.advance(1);
    expect((await getQuote(alice, created.body.quoteId).expect(200)).body.status).toBe('EXPIRED');
    expect(await codeOf(fx.quotes.consume(created.body.quoteId, alice.userId))).toBe(ErrorCode.QUOTE_EXPIRED);
  });

  it('idempotent creation: same key → the same quote, byte-identical; different body → 409; nothing new created', async () => {
    const key = randomUUID();
    const first = await fx.quote(alice, { from: 'NGN', to: 'EUR', sourceAmount: '500000' }, key).expect(201);
    const count = async () => ((await harness.dataSource.query(`SELECT count(*)::int AS n FROM quotes WHERE user_id = $1`, [alice.userId])) as { n: number }[])[0].n;
    const before = await count();
    const again = await fx.quote(alice, { sourceAmount: '500000', to: 'EUR', from: 'NGN' }, key).expect(201);
    expect(again.text).toBe(first.text);
    expect(again.headers['idempotent-replayed']).toBe('true');
    const different = await fx.quote(alice, { from: 'NGN', to: 'EUR', sourceAmount: '500001' }, key);
    expect([different.status, different.body.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSE']);
    expect(await count()).toBe(before);
  });

  it('a stale rate is refused 503 FX_RATE_STALE and the key is NOT stored: the retry is processed afresh', async () => {
    clock.advance(361_000); // age 421s: display-only
    const key = randomUUID();
    const refused = await fx.quote(alice, { from: 'NGN', to: 'USD', sourceAmount: '1000000' }, key);
    expect([refused.status, refused.body.code]).toEqual([503, 'FX_RATE_STALE']);
    const stored = (await harness.dataSource.query(`SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1`, [key])) as { n: number }[];
    expect(stored[0].n).toBe(0);
    fx.publishFresh();
    await fx.fetcher.fetch('POLL');
    const retried = await fx.quote(alice, { from: 'NGN', to: 'USD', sourceAmount: '1000000' }, key);
    expect(retried.status).toBe(201);
    expect(retried.headers['idempotent-replayed']).toBeUndefined();
  });

  it('a quote needs a verified user (the global guard chain)', async () => {
    const response = await http().post(`/${API_PREFIX}/fx/quotes`).set('Idempotency-Key', randomUUID()).send({ from: 'NGN', to: 'USD', sourceAmount: '100000' });
    expect(response.status).toBe(401);
  });

  describe('consume(quoteId, userId) — the Phase 7 primitive', () => {
    it('succeeds exactly once; then QUOTE_ALREADY_USED', async () => {
      const created = await fx.quote(alice, { from: 'NGN', to: 'USD', sourceAmount: '1000000' }).expect(201);
      const consumed = await fx.quotes.consume(created.body.quoteId, alice.userId);
      expect(consumed).toMatchObject({ id: created.body.quoteId, sourceAmountMinor: 1_000_000n, targetAmountMinor: BigInt(created.body.targetAmount) });
      expect(consumed.consumedAt).toEqual(clock.now());
      expect(await codeOf(fx.quotes.consume(created.body.quoteId, alice.userId))).toBe(ErrorCode.QUOTE_ALREADY_USED);
      expect((await getQuote(alice, created.body.quoteId).expect(200)).body.status).toBe('CONSUMED');
    });

    it('refuses a foreign quote as not found (non-transferable, no existence leak), and an unknown id', async () => {
      const created = await fx.quote(alice, { from: 'NGN', to: 'USD', sourceAmount: '1000000' }).expect(201);
      expect(await codeOf(fx.quotes.consume(created.body.quoteId, bob.userId))).toBe(ErrorCode.QUOTE_NOT_FOUND);
      expect(await codeOf(fx.quotes.consume(randomUUID(), alice.userId))).toBe(ErrorCode.QUOTE_NOT_FOUND);
      // Bob's attempt changed nothing: Alice can still use it.
      expect(await codeOf(fx.quotes.consume(created.body.quoteId, alice.userId))).toBe('SUCCEEDED');
    });

    it('an expired quote is refused QUOTE_EXPIRED and stays unconsumed', async () => {
      const created = await fx.quote(alice, { from: 'NGN', to: 'USD', sourceAmount: '1000000' }).expect(201);
      clock.advance(30_000);
      expect(await codeOf(fx.quotes.consume(created.body.quoteId, alice.userId))).toBe(ErrorCode.QUOTE_EXPIRED);
      expect((await quoteRow(created.body.quoteId)).consumed_at).toBeNull();
    });
  });
});
