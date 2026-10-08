import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { Money } from '../../src/common/money';
import { RECORDED_RATES } from '../../src/mock-exchange-rate-api/mock-exchange-rate-api';
import { TradingMetrics } from '../../src/modules/trading/trading-metrics';
import { TestClock } from '../support/auth-test-doubles';
import { FxHarness, LedgerHarness, LedgerSnapshot, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

/**
 * Conversion and trading (design §7.7; PHASE7_PLAN §C–§E) through the real HTTP pipeline:
 * guards → RateSnapshotGuard (convert) → idempotency barrier → the shared primitive.
 * Expected amounts are pinned from an independent 60-digit Python `decimal` oracle at the
 * mock provider's recorded rates (NGN 1329.375909, EUR 0.879241, GBP 0.754467 per USD).
 * `expectCleanBooks()` runs after every test.
 */
describe('Trading: convert and trade (integration)', () => {
  let harness: LedgerHarness;
  let fx: FxHarness;
  let payments: PaymentsHarness;
  let clock: TestClock;
  let alice: SignedUpUser;
  let bob: SignedUpUser;
  let owner: Client;
  let superuser: Client;

  beforeAll(async () => {
    harness = await startLedgerHarness(
      {
        // NGN: ₦10,000,000 per conversion, ₦15,000,000 per rolling 24 hours.
        CONVERSION_LIMITS: JSON.stringify({
          NGN: { maximum: '1000000000', dailyMaximum: '1500000000' },
          USD: { maximum: '1000000', dailyMaximum: '5000000' },
          EUR: { maximum: '1000000', dailyMaximum: '5000000' },
          GBP: { maximum: '1000000', dailyMaximum: '5000000' },
        }),
      },
      { fx: true },
    );
    fx = harness.fx!;
    payments = harness.payments!;
    clock = harness.auth!.clock;
    owner = await harness.db.ownerClient();
    superuser = await harness.db.superuserClient();
  });
  afterAll(async () => {
    await owner?.end();
    await superuser?.end();
    await harness?.close();
  });
  beforeEach(async () => {
    clock.advance(86_400_000);
    alice = await payments.signUp();
    bob = await payments.signUp();
    fx.api.clearFaults();
    await fx.resetRedisState();
    await payments.clearRateLimits();
    await fx.warm();
  });
  afterEach(async () => {
    await harness.expectCleanBooks();
  });

  const http = () => request(harness.auth!.app.getHttpServer());
  const convert = (user: SignedUpUser, body: Record<string, unknown>, key: string = randomUUID()) =>
    http().post(`/${API_PREFIX}/wallet/convert`).set('Authorization', `Bearer ${user.accessToken}`).set('Idempotency-Key', key).send(body);
  const trade = (user: SignedUpUser, body: Record<string, unknown>, key: string = randomUUID()) =>
    http().post(`/${API_PREFIX}/wallet/trade`).set('Authorization', `Bearer ${user.accessToken}`).set('Idempotency-Key', key).send(body);
  const wallet = async (user: SignedUpUser) =>
    (await http().get(`/${API_PREFIX}/wallet`).set('Authorization', `Bearer ${user.accessToken}`).expect(200)).body.balances as {
      currency: string;
      total: string;
      reserved: string;
      available: string;
    }[];
  const balanceOf = async (user: SignedUpUser, currency: string) => (await wallet(user)).find((row) => row.currency === currency);

  /** Credit a user directly through the ledger (funding itself is Phase 5's, tested there and in the e2e). */
  const credit = async (user: SignedUpUser, currency: string, amountMinor: bigint) => {
    const [{ id: walletId }] = (await harness.dataSource.query(`SELECT id FROM wallets WHERE user_id = $1`, [user.userId])) as { id: string }[];
    const account = await harness.chartOfAccounts.openUserAccount(walletId, currency);
    await harness.fund({ userId: user.userId, walletId, accountId: account.id, currency }, amountMinor);
    return account.id;
  };

  const transactionRow = async (transactionId: string) =>
    ((await harness.dataSource.query(
      `SELECT type, status, user_id, reference, source_currency, source_amount_minor::text AS source_amount, target_currency,
              target_amount_minor::text AS target_amount, rate_display::text AS rate_display, reference_rate::text AS reference_rate,
              rate_provider, rate_fetched_at, rate_provider_updated_at, rate_snapshot_id, spread_basis_points, quote_id,
              reason_code, initiated_by, idempotency_key, metadata, value_time, booking_time, settlement_time, external_reference
         FROM transactions WHERE id = $1`,
      [transactionId],
    )) as Record<string, unknown>[])[0];

  /** Entries as `account direction amount`, user wallets anonymised, sorted (ids follow the ledger's lock order, not the draft's). */
  const entriesOf = async (transactionId: string) =>
    (
      (await harness.dataSource.query(
        `SELECT accounts.code, ledger_entries.direction, ledger_entries.amount_minor::text AS amount
           FROM ledger_entries JOIN accounts ON accounts.id = ledger_entries.account_id
          WHERE ledger_entries.transaction_id = $1 ORDER BY ledger_entries.id`,
        [transactionId],
      )) as { code: string; direction: string; amount: string }[]
    )
      .map((row) => `${row.code.replace(/^USER:[0-9a-f-]+:/, 'USER:')} ${row.direction} ${row.amount}`)
      .sort();

  const keyRow = async (key: string) =>
    ((await harness.dataSource.query(`SELECT status, response_status_code, transaction_id FROM idempotency_keys WHERE key = $1`, [key])) as {
      status: string;
      response_status_code: number;
      transaction_id: string | null;
    }[])[0];

  /** Everything but the idempotency key count (a permanent refusal is stored, by design). */
  const withoutKeys = (snapshot: LedgerSnapshot) => ({ ...snapshot, idempotencyKeyCount: 0 });

  describe('convert', () => {
    it('₦1,000,000 → USD posts the five §5.6 entries with full provenance, opens the USD account, links key and flow', async () => {
      await credit(alice, 'NGN', 100_000_000n);
      const key = randomUUID();
      const response = await convert(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000000' }, key);
      expect(response.status).toBe(201);
      const body = response.body;
      expect(body).toEqual({
        transactionId: expect.any(String),
        reference: expect.stringMatching(/^conversion:[0-9a-f-]{36}$/),
        type: 'CONVERSION',
        status: 'POSTED',
        quoteId: null,
        amountMode: 'SOURCE',
        debited: { currency: 'NGN', minorUnit: 2, amount: '100000000' },
        credited: { currency: 'USD', minorUnit: 2, amount: '74094' },
        rateDisplay: '0.00074094',
        clientRate: '0.000740949187759',
        midRate: '0.000752232677928',
        spreadBasisPoints: 150,
        rate: { provider: 'exchange-rate-api', asOf: expect.any(String), fetchedAt: expect.any(String), snapshotId: expect.any(String) },
        valueTime: expect.any(String),
        bookingTime: expect.any(String),
      });
      expect(body.valueTime).toBe(body.bookingTime);

      expect(await entriesOf(body.transactionId)).toEqual(
        [
          'USER:NGN DEBIT 100000000',
          'FX_POSITION:NGN CREDIT 100000000',
          'FX_POSITION:USD DEBIT 75223',
          'USER:USD CREDIT 74094',
          'REVENUE:FX_SPREAD:USD CREDIT 1129',
        ].sort(),
      );
      expect(await balanceOf(alice, 'NGN')).toMatchObject({ total: '0', reserved: '0', available: '0' });
      expect(await balanceOf(alice, 'USD')).toMatchObject({ total: '74094', reserved: '0', available: '74094' });

      const flowId = body.reference.slice('conversion:'.length);
      const row = await transactionRow(body.transactionId);
      expect(row).toMatchObject({
        type: 'CONVERSION',
        status: 'POSTED',
        user_id: alice.userId,
        reference: body.reference,
        source_currency: 'NGN',
        source_amount: '100000000',
        target_currency: 'USD',
        target_amount: '74094',
        rate_display: '0.00074094',
        rate_provider: 'exchange-rate-api',
        rate_snapshot_id: body.rate.snapshotId,
        spread_basis_points: 150,
        quote_id: null,
        reason_code: 'MARKET_CONVERSION',
        initiated_by: `user:${alice.userId}`,
        idempotency_key: key,
        metadata: { flowId, amountMode: 'SOURCE' },
        settlement_time: null,
        external_reference: null,
      });
      // The exact mid (34 significant digits), not the display string: 1 / 1329.375909.
      expect(row.reference_rate).toBe('0.0007522326779279704849834163799338115');
      expect((row.rate_provider_updated_at as Date).toISOString()).toBe(body.rate.asOf);
      expect((row.value_time as Date).getTime()).toBe((row.booking_time as Date).getTime());

      const [flow] = (await harness.dataSource.query(`SELECT flow_type, state, completed_at FROM flow_instances WHERE id = $1`, [flowId])) as {
        flow_type: string;
        state: string;
        completed_at: Date | null;
      }[];
      expect(flow).toMatchObject({ flow_type: 'CONVERSION', state: 'POSTED' });
      expect(flow.completed_at).not.toBeNull();
      const reservations = (await harness.dataSource.query(
        `SELECT status, settled_minor::text AS settled, settlement_transaction_id FROM reservations WHERE flow_id = $1`,
        [flowId],
      )) as { status: string; settled: string; settlement_transaction_id: string }[];
      expect(reservations).toEqual([{ status: 'SETTLED', settled: '100000000', settlement_transaction_id: body.transactionId }]);
      expect(await keyRow(key)).toEqual({ status: 'COMPLETED', response_status_code: 201, transaction_id: body.transactionId });

      const [event] = (await harness.dataSource.query(
        `SELECT event_type, aggregate_id, payload FROM outbox_events WHERE aggregate_id = $1`,
        [body.transactionId],
      )) as { event_type: string; aggregate_id: string; payload: unknown }[];
      expect(event).toEqual({
        event_type: 'ConversionPosted.v1',
        aggregate_id: body.transactionId,
        payload: { transactionId: body.transactionId, userId: alice.userId, flowId, quoteId: null },
      });
      const audits = (await harness.dataSource.query(`SELECT action, subject_id, after FROM audit_logs WHERE subject_id = $1`, [flowId])) as unknown[];
      expect(audits).toEqual([{ action: 'CONVERSION_POSTED', subject_id: flowId, after: { flowState: 'POSTED', transactionId: body.transactionId } }]);

      // The worker acknowledges the event (a registered handler, so it is published, not dead-lettered).
      await harness.auth!.deliverOutbox();
      const [published] = (await harness.dataSource.query(`SELECT published_at, failed_at FROM outbox_events WHERE aggregate_id = $1`, [
        body.transactionId,
      ])) as { published_at: Date | null; failed_at: Date | null }[];
      expect(published.published_at).not.toBeNull();
      expect(published.failed_at).toBeNull();
      expect(harness.moduleRef.get(TradingMetrics).conversionsTotal()).toContainEqual(expect.objectContaining({ from: 'NGN', to: 'USD', outcome: 'POSTED' }));
    });

    it('USD → NGN, TARGET mode ("buy $50 with NGN") and EUR → GBP post their exact amounts', async () => {
      await credit(alice, 'USD', 50_000n);
      const usdToNgn = await convert(alice, { from: 'USD', to: 'NGN', sourceAmount: '50000' }).expect(201);
      expect([usdToNgn.body.debited.amount, usdToNgn.body.credited.amount]).toEqual(['50000', '65471763']);
      expect(await entriesOf(usdToNgn.body.transactionId)).toContain('REVENUE:FX_SPREAD:NGN CREDIT 997032');

      await credit(bob, 'NGN', 6_748_102n);
      const buy = await convert(bob, { from: 'NGN', to: 'USD', targetAmount: '5000' }).expect(201);
      expect(buy.body).toMatchObject({ amountMode: 'TARGET', debited: { amount: '6748102' }, credited: { amount: '5000' } });
      expect(await balanceOf(bob, 'NGN')).toMatchObject({ total: '0' });

      await credit(alice, 'EUR', 10_000n);
      const cross = await convert(alice, { from: 'EUR', to: 'GBP', sourceAmount: '10000' }).expect(201);
      expect(await entriesOf(cross.body.transactionId)).toEqual(
        [
          'USER:EUR DEBIT 10000',
          'FX_POSITION:EUR CREDIT 10000',
          'FX_POSITION:GBP DEBIT 8581',
          'USER:GBP CREDIT 8537',
          'REVENUE:FX_SPREAD:GBP CREDIT 44',
        ].sort(),
      );
    });

    it('a replay returns the identical stored bytes after the rate has moved, and posts nothing', async () => {
      await credit(alice, 'NGN', 200_000_000n);
      const key = randomUUID();
      const body = { from: 'NGN', to: 'USD', sourceAmount: '100000000' };
      const first = await convert(alice, body, key).expect(201);
      clock.advance(120_000);
      await fx.warm({ ...RECORDED_RATES, NGN: '1400' });
      const before = await harness.snapshot();
      const replay = await convert(alice, body, key).expect(201);
      expect(replay.text).toBe(first.text);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(await harness.snapshot()).toEqual(before);
      // A new key is a new conversion, at the new rate.
      const fresh = await convert(alice, body).expect(201);
      expect(fresh.body.credited.amount).not.toBe(first.body.credited.amount);
      expect(fresh.body.rate.snapshotId).not.toBe(first.body.rate.snapshotId);
    });

    it.each([
      ['the same currency', { from: 'NGN', to: 'NGN', sourceAmount: '100000' }, 400, 'SAME_CURRENCY'],
      ['an unknown currency', { from: 'NGN', to: 'XYZ', sourceAmount: '100000' }, 400, 'UNSUPPORTED_CURRENCY'],
      ['both amounts', { from: 'NGN', to: 'USD', sourceAmount: '100000', targetAmount: '100' }, 400, 'VALIDATION_FAILED'],
      ['neither amount', { from: 'NGN', to: 'USD' }, 400, 'VALIDATION_FAILED'],
      ['a JSON number amount', { from: 'NGN', to: 'USD', sourceAmount: 100000 }, 400, 'VALIDATION_FAILED'],
      ['a zero amount', { from: 'NGN', to: 'USD', sourceAmount: '0' }, 400, 'VALIDATION_FAILED'],
      ['a negative amount', { from: 'NGN', to: 'USD', sourceAmount: '-100000' }, 400, 'VALIDATION_FAILED'],
      ['a fractional amount', { from: 'NGN', to: 'USD', sourceAmount: '1000.5' }, 400, 'VALIDATION_FAILED'],
      ['an amount beyond BIGINT', { from: 'NGN', to: 'USD', sourceAmount: '99999999999999999999' }, 400, 'VALIDATION_FAILED'],
      ['the superseded maxSlippageBps', { from: 'NGN', to: 'USD', sourceAmount: '100000', maxSlippageBps: 50 }, 400, 'VALIDATION_FAILED'],
      ['a bound that does not match the mode', { from: 'NGN', to: 'USD', sourceAmount: '100000', maximumSourceAmount: '100000' }, 400, 'VALIDATION_FAILED'],
      ['an amount below the pair minimum (₦1,000)', { from: 'NGN', to: 'USD', sourceAmount: '99999' }, 422, 'AMOUNT_TOO_SMALL'],
      ['an amount above the per-conversion maximum (₦10,000,000)', { from: 'NGN', to: 'USD', sourceAmount: '1000000001' }, 422, 'AMOUNT_TOO_LARGE'],
      ['a TARGET amount whose debit exceeds the maximum', { from: 'NGN', to: 'USD', targetAmount: '1000000' }, 422, 'AMOUNT_TOO_LARGE'],
      ['a TARGET amount whose debit leaves BIGINT', { from: 'NGN', to: 'USD', targetAmount: '9000000000000000000' }, 422, 'AMOUNT_TOO_LARGE'],
      ['no NGN at all', { from: 'NGN', to: 'USD', sourceAmount: '100000' }, 409, 'INSUFFICIENT_FUNDS'],
    ])('refuses %s, and writes nothing but the stored refusal', async (_name, body, status, code) => {
      const before = await harness.snapshot();
      const key = randomUUID();
      const response = await convert(alice, body, key);
      expect([response.status, response.body.code]).toEqual([status, code]);
      expect(withoutKeys(await harness.snapshot())).toEqual(withoutKeys(before));
      // Permanent: stored and replayed for that key.
      expect(await keyRow(key)).toMatchObject({ status: 'FAILED_PERMANENT', response_status_code: status, transaction_id: null });
    });

    it('insufficient available balance: 409 INSUFFICIENT_FUNDS stating available vs reserved', async () => {
      await credit(alice, 'NGN', 79_999n);
      const response = await convert(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000' });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'INSUFFICIENT_FUNDS',
        details: { requestedMinor: '100000', balanceMinor: '79999', reservedMinor: '0', availableMinor: '79999' },
      });
    });

    it('balance sufficient but held by another flow: 409 FUNDS_RESERVED; within available it converts', async () => {
      const accountId = await credit(alice, 'NGN', 200_000n);
      const [flowId] = await harness.newFlowIds(1);
      const hold = await harness.reservations.reserve({
        accountId,
        flowId,
        amount: Money.of(100_000n, 'NGN'),
        expiresAt: new Date(Date.now() + 600_000),
      });
      try {
        const refused = await convert(alice, { from: 'NGN', to: 'USD', sourceAmount: '150000' });
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({
          code: 'FUNDS_RESERVED',
          details: { requestedMinor: '150000', balanceMinor: '200000', reservedMinor: '100000', availableMinor: '100000' },
        });
        await convert(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000' }).expect(201);
        expect(await balanceOf(alice, 'NGN')).toMatchObject({ total: '100000', reserved: '100000', available: '0' });
      } finally {
        await harness.reservations.release(hold.id);
      }
    });

    it('a price bound: SOURCE mode minimumTargetAmount, TARGET mode maximumSourceAmount → 409 PRICE_LIMIT_EXCEEDED with the priced amounts', async () => {
      await credit(alice, 'NGN', 200_000_000n);
      const tooHigh = await convert(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000000', minimumTargetAmount: '74095' });
      expect([tooHigh.status, tooHigh.body.code]).toEqual([409, 'PRICE_LIMIT_EXCEEDED']);
      expect(tooHigh.body.details).toEqual({ from: 'NGN', to: 'USD', sourceAmount: '100000000', targetAmount: '74094', minimumTargetAmount: '74095' });
      await convert(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000000', minimumTargetAmount: '74094' }).expect(201);

      const tooCostly = await convert(alice, { from: 'NGN', to: 'USD', targetAmount: '5000', maximumSourceAmount: '6748101' });
      expect([tooCostly.status, tooCostly.body.code]).toEqual([409, 'PRICE_LIMIT_EXCEEDED']);
      expect(tooCostly.body.details).toMatchObject({ sourceAmount: '6748102', maximumSourceAmount: '6748101' });
      await convert(alice, { from: 'NGN', to: 'USD', targetAmount: '5000', maximumSourceAmount: '6748102' }).expect(201);
    });

    it('rolling 24-hour limit per user and source currency: 422 DAILY_LIMIT_EXCEEDED with what remains; trades count; other users unaffected', async () => {
      await credit(alice, 'NGN', 2_000_000_000n);
      await convert(alice, { from: 'NGN', to: 'USD', sourceAmount: '1000000000' }).expect(201);
      const over = await convert(alice, { from: 'NGN', to: 'USD', sourceAmount: '500000001' });
      expect([over.status, over.body.code]).toEqual([422, 'DAILY_LIMIT_EXCEEDED']);
      expect(over.body.details).toEqual({
        currency: 'NGN',
        dailyMaximumMinor: '1500000000',
        convertedInWindowMinor: '1000000000',
        remainingMinor: '500000000',
        sourceAmount: '500000001',
      });
      await convert(alice, { from: 'NGN', to: 'EUR', sourceAmount: '500000000' }).expect(201);
      const quote = await fx.quote(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000' }).expect(201);
      const traded = await trade(alice, { quoteId: quote.body.quoteId });
      expect([traded.status, traded.body.code]).toEqual([422, 'DAILY_LIMIT_EXCEEDED']);
      // The limit is per source currency: selling USD is unaffected.
      await convert(alice, { from: 'USD', to: 'NGN', sourceAmount: '100' }).expect(201);
      await credit(bob, 'NGN', 1_000_000_000n);
      await convert(bob, { from: 'NGN', to: 'USD', sourceAmount: '1000000000' }).expect(201);
    });

    it('a pair that is not active is refused 400 UNSUPPORTED_CURRENCY_PAIR', async () => {
      await credit(alice, 'EUR', 10_000n);
      await owner.query(`UPDATE currency_pairs SET is_active = FALSE WHERE source_currency_code = 'EUR' AND target_currency_code = 'GBP'`);
      try {
        const response = await convert(alice, { from: 'EUR', to: 'GBP', sourceAmount: '10000' });
        expect([response.status, response.body.code]).toEqual([400, 'UNSUPPORTED_CURRENCY_PAIR']);
      } finally {
        await owner.query(`UPDATE currency_pairs SET is_active = TRUE WHERE source_currency_code = 'EUR' AND target_currency_code = 'GBP'`);
      }
    });

    it('a stale rate: 503 FX_RATE_STALE + Retry-After, the key NOT stored', async () => {
      await credit(alice, 'NGN', 200_000_000n);
      clock.advance(361_000); // the rate is now 421s old: display-only.
      const before = await harness.snapshot();
      const key = randomUUID();
      const refused = await convert(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000' }, key);
      expect([refused.status, refused.body.code]).toEqual([503, 'FX_RATE_STALE']);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(await keyRow(key)).toBeUndefined();
      expect(await harness.snapshot()).toEqual(before);
      fx.publishFresh();
      await fx.fetcher.fetch('POLL');
      const retried = await convert(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000' }, key);
      expect(retried.status).toBe(201);
      expect(retried.headers['idempotent-replayed']).toBeUndefined();
    });

    it('a trade executes its locked amounts even when the current rate is stale', async () => {
      await credit(alice, 'NGN', 200_000n);
      // The rate was published 60s ago; at 400s old (BUSINESS: executable up to 420s) quote,
      // then 25s later the rate is 425s old — stale for execution — and the quote has 5s left.
      clock.advance(340_000);
      const quote = await fx.quote(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000' }).expect(201);
      clock.advance(25_000);
      const market = await convert(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000' });
      expect([market.status, market.body.code]).toEqual([503, 'FX_RATE_STALE']);
      const response = await trade(alice, { quoteId: quote.body.quoteId });
      expect(response.status).toBe(201);
      expect(response.body.credited.amount).toBe(quote.body.targetAmount);
    });

    it('a user suspended mid-flight is refused 403 inside the transaction, and nothing is written', async () => {
      await credit(alice, 'NGN', 100_000n);
      const before = await harness.snapshot();
      await owner.query('BEGIN');
      await owner.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [alice.userId]);
      // The guard chain still sees ACTIVE (MVCC); the conversion's FOR SHARE on the user row waits for us.
      const pending = convert(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000' }).then((response) => response);
      const deadline = Date.now() + 2_500;
      for (;;) {
        const waiting = (await superuser.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FROM users WHERE id = $1 FOR SHARE%'`,
        )).rows[0] as { n: number };
        if (waiting.n > 0) break;
        if (Date.now() > deadline) throw new Error('the conversion never waited on the user row');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await owner.query('COMMIT');
      const response = await pending;
      expect([response.status, response.body.code]).toEqual([403, 'ACCOUNT_SUSPENDED']);
      const after = await harness.snapshot();
      expect(withoutKeys(after)).toEqual(withoutKeys(before));
    });

    it('posting, outbox and audit commit together: a failure after the posting leaves no half behind (and no key)', async () => {
      await credit(alice, 'NGN', 100_000n);
      await superuser.query(`
        CREATE FUNCTION test_fail_conversion_audit() RETURNS trigger AS $$
        BEGIN
          IF NEW.action = 'CONVERSION_POSTED' THEN RAISE EXCEPTION 'injected failure after the posting'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await superuser.query(`CREATE TRIGGER test_fail_conversion_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_fail_conversion_audit()`);
      try {
        const before = await harness.snapshot();
        const key = randomUUID();
        const response = await convert(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000' }, key);
        expect(response.status).toBe(500);
        expect(await harness.snapshot()).toEqual(before);
        expect(await keyRow(key)).toBeUndefined();
      } finally {
        await superuser.query(`DROP TRIGGER test_fail_conversion_audit ON audit_logs`);
        await superuser.query(`DROP FUNCTION test_fail_conversion_audit()`);
      }
      await convert(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000' }).expect(201);
    });

    it('needs a verified, authenticated user (the global guard chain)', async () => {
      const response = await http().post(`/${API_PREFIX}/wallet/convert`).set('Idempotency-Key', randomUUID()).send({ from: 'NGN', to: 'USD', sourceAmount: '100000' });
      expect(response.status).toBe(401);
      const trading = await http().post(`/${API_PREFIX}/wallet/trade`).set('Idempotency-Key', randomUUID()).send({ quoteId: randomUUID() });
      expect(trading.status).toBe(401);
    });
  });

  describe('trade', () => {
    it('posts the quote verbatim, with the quote’s provenance, even after the rate moved', async () => {
      await credit(alice, 'NGN', 100_000_000n);
      const quote = await fx.quote(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000000' }).expect(201);
      clock.advance(10_000);
      await fx.warm({ ...RECORDED_RATES, NGN: '1400' });
      const key = randomUUID();
      const response = await trade(alice, { quoteId: quote.body.quoteId }, key).expect(201);
      expect(response.body).toMatchObject({
        quoteId: quote.body.quoteId,
        amountMode: 'SOURCE',
        debited: { currency: 'NGN', amount: '100000000' },
        credited: { currency: 'USD', amount: quote.body.targetAmount },
        midRate: quote.body.midRate,
        clientRate: quote.body.clientRate,
        spreadBasisPoints: 150,
        rate: quote.body.rate,
      });
      expect(quote.body.targetAmount).toBe('74094');
      expect(await entriesOf(response.body.transactionId)).toContain('REVENUE:FX_SPREAD:USD CREDIT 1129');
      expect(await transactionRow(response.body.transactionId)).toMatchObject({
        quote_id: quote.body.quoteId,
        reason_code: 'QUOTED_TRADE',
        rate_snapshot_id: quote.body.rate.snapshotId,
      });
      const consumed = await http().get(`/${API_PREFIX}/fx/quotes/${quote.body.quoteId}`).set('Authorization', `Bearer ${alice.accessToken}`).expect(200);
      expect(consumed.body.status).toBe('CONSUMED');
      expect(await keyRow(key)).toMatchObject({ status: 'COMPLETED', transaction_id: response.body.transactionId });

      // Replay: identical bytes, no second consumption or posting.
      const before = await harness.snapshot();
      const replay = await trade(alice, { quoteId: quote.body.quoteId }, key).expect(201);
      expect(replay.text).toBe(response.text);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(await harness.snapshot()).toEqual(before);
    });

    it('a TARGET quote ("buy $50 with NGN") trades its derived debit', async () => {
      await credit(alice, 'NGN', 6_748_102n);
      const quote = await fx.quote(alice, { from: 'NGN', to: 'USD', targetAmount: '5000' }).expect(201);
      const response = await trade(alice, { quoteId: quote.body.quoteId }).expect(201);
      expect(response.body).toMatchObject({ amountMode: 'TARGET', debited: { amount: '6748102' }, credited: { amount: '5000' } });
      expect(await balanceOf(alice, 'NGN')).toMatchObject({ total: '0' });
    });

    it('expired, used, foreign, unknown or malformed quotes are refused; nothing but the refusal is stored', async () => {
      await credit(alice, 'NGN', 1_000_000n);
      const used = await fx.quote(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000' }).expect(201);
      await trade(alice, { quoteId: used.body.quoteId }).expect(201);
      const foreign = await fx.quote(bob, { from: 'NGN', to: 'USD', sourceAmount: '100000' }).expect(201);
      const expired = await fx.quote(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000' }).expect(201);
      clock.advance(30_000);
      const cases: [string, Record<string, unknown>, number, string][] = [
        ['used', { quoteId: used.body.quoteId }, 409, 'QUOTE_ALREADY_USED'],
        ['expired', { quoteId: expired.body.quoteId }, 409, 'QUOTE_EXPIRED'],
        ['another user’s', { quoteId: foreign.body.quoteId }, 404, 'QUOTE_NOT_FOUND'],
        ['unknown', { quoteId: randomUUID() }, 404, 'QUOTE_NOT_FOUND'],
        ['malformed', { quoteId: 'not-a-uuid' }, 400, 'VALIDATION_FAILED'],
        ['with extra fields', { quoteId: randomUUID(), side: 'BUY' }, 400, 'VALIDATION_FAILED'],
      ];
      for (const [name, body, status, code] of cases) {
        const before = await harness.snapshot();
        const response = await trade(alice, body);
        expect({ name, status: response.status, code: response.body.code }).toEqual({ name, status, code });
        expect(withoutKeys(await harness.snapshot())).toEqual(withoutKeys(before));
      }
      const [row] = (await harness.dataSource.query(`SELECT consumed_at FROM quotes WHERE id = $1`, [foreign.body.quoteId])) as {
        consumed_at: Date | null;
      }[];
      expect(row.consumed_at).toBeNull();
    });

    it('a trade refused for funds leaves its quote unconsumed: that key replays the refusal, a new key succeeds', async () => {
      await credit(alice, 'NGN', 50_000n);
      const quote = await fx.quote(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000' }).expect(201);
      const key = randomUUID();
      const refused = await trade(alice, { quoteId: quote.body.quoteId }, key);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS', details: { availableMinor: '50000', reservedMinor: '0' } });
      const [row] = (await harness.dataSource.query(`SELECT consumed_at FROM quotes WHERE id = $1`, [quote.body.quoteId])) as {
        consumed_at: Date | null;
      }[];
      expect(row.consumed_at).toBeNull();

      await credit(alice, 'NGN', 50_000n);
      const replayed = await trade(alice, { quoteId: quote.body.quoteId }, key);
      expect([replayed.status, replayed.text, replayed.headers['idempotent-replayed']]).toEqual([409, refused.text, 'true']);
      const retried = await trade(alice, { quoteId: quote.body.quoteId }).expect(201);
      expect(retried.body.credited.amount).toBe(quote.body.targetAmount);
    });

    it('the same key on /convert and /trade is two operations (scope is user, endpoint, key)', async () => {
      await credit(alice, 'NGN', 200_000n);
      const key = randomUUID();
      const quote = await fx.quote(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000' }).expect(201);
      await convert(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000' }, key).expect(201);
      await trade(alice, { quoteId: quote.body.quoteId }, key).expect(201);
      expect(await balanceOf(alice, 'NGN')).toMatchObject({ total: '0' });
    });
  });
});
