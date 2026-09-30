import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { dec } from '../../src/common/money';
import { displayRate } from '../../src/modules/fx/pricing';
import { PUBLIC_REASON_CODES } from '../../src/modules/transactions/history-status';
import { TestClock } from '../support/auth-test-doubles';
import { FxHarness, LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

const DEMO_CREDIT_MINOR = '10000000'; // ₦100,000.00

/**
 * History (design §7.8; PHASE8_PLAN) through the real HTTP pipeline, asserted against the
 * `transactions` / `ledger_entries` rows — never against figures the test invented.
 */
describe('Transaction history (integration)', () => {
  let harness: LedgerHarness;
  let fx: FxHarness;
  let payments: PaymentsHarness;
  let clock: TestClock;

  beforeAll(async () => {
    harness = await startLedgerHarness({ DEMO_CREDIT_NGN_MINOR: DEMO_CREDIT_MINOR }, { fx: true });
    fx = harness.fx!;
    payments = harness.payments!;
    clock = harness.auth!.clock;
  });
  afterAll(async () => harness?.close());
  beforeEach(async () => {
    clock.advance(86_400_000);
    const { psp } = payments;
    psp.setCaptureCompletion('immediate');
    psp.clearFaults();
    for (const event of psp.pendingWebhooks()) psp.drop(event.id);
    fx.api.clearFaults();
    await fx.resetRedisState();
    await payments.clearRateLimits();
    await fx.warm();
  });
  afterEach(async () => {
    await harness.expectCleanBooks();
  });

  const http = () => request(harness.auth!.app.getHttpServer());
  const history = (user: SignedUpUser, query: Record<string, string> = {}) =>
    http().get(`/${API_PREFIX}/transactions`).query(query).set('Authorization', `Bearer ${user.accessToken}`);
  const detail = (user: SignedUpUser, reference: string) =>
    http().get(`/${API_PREFIX}/transactions/${reference}`).set('Authorization', `Bearer ${user.accessToken}`);
  const post = (user: SignedUpUser, path: string, body: Record<string, unknown>) =>
    http().post(`/${API_PREFIX}${path}`).set('Authorization', `Bearer ${user.accessToken}`).set('Idempotency-Key', randomUUID()).send(body);

  const fund = async (user: SignedUpUser, amount = '5000000', token = 'tok_success_visa') => {
    const response = await payments.fund(user, { amount, currency: 'NGN', paymentMethodToken: token });
    expect(response.status).toBe(202);
    return response.body.fundingId as string;
  };
  const paymentIdOf = async (flowId: string) =>
    ((await harness.dataSource.query(`SELECT provider_payment_id FROM funding_payments WHERE flow_id = $1`, [flowId])) as { provider_payment_id: string }[])[0]
      .provider_payment_id;

  /** Everything the books say about a user, straight from the tables. */
  const booksOf = async (userId: string) => {
    const transactions = (await harness.dataSource.query(
      `SELECT id::text AS id, reference, type::text AS type, status::text AS status, reason_code, value_time, booking_time,
              settlement_time, rate_display::text AS rate_display, reference_rate::text AS reference_rate, rate_provider,
              rate_fetched_at, rate_provider_updated_at, rate_snapshot_id::text AS rate_snapshot_id, spread_basis_points,
              quote_id::text AS quote_id, corrects_transaction_id::text AS corrects_transaction_id,
              corrected_by_transaction_id::text AS corrected_by_transaction_id, initiated_by
         FROM transactions WHERE user_id = $1
        ORDER BY transactions.value_time DESC, transactions.id DESC`,
      [userId],
    )) as Record<string, any>[];
    const entries = (await harness.dataSource.query(
      `SELECT ledger_entries.transaction_id::text AS transaction_id, ledger_entries.currency_code AS currency,
              currencies.minor_unit AS "minorUnit", ledger_entries.direction::text AS direction,
              ledger_entries.amount_minor::text AS amount, ledger_entries.balance_after_minor::text AS "balanceAfter"
         FROM ledger_entries
         JOIN accounts ON accounts.id = ledger_entries.account_id
         JOIN wallets ON wallets.id = accounts.wallet_id
         JOIN currencies ON currencies.code = ledger_entries.currency_code
        WHERE wallets.user_id = $1
        ORDER BY ledger_entries.direction, ledger_entries.id`,
      [userId],
    )) as Record<string, any>[];
    return { transactions, entries };
  };

  const expectedStatus = (status: string) => ({ POSTED: 'COMPLETED', REVERSED: 'REVERSED' })[status];
  const referenceOf = (transactions: Record<string, any>[], id: string | null) => {
    if (id === null) return null;
    const linked = transactions.find((row) => row.id === id)!;
    return { reference: linked.reference, type: linked.type };
  };

  /** A user with every kind of history: demo credit, a funding, a market conversion, a quoted trade, a charged-back funding. */
  const richUser = async () => {
    const user = await payments.signUp();
    const fundingId = await fund(user);
    await payments.drive();
    const converted = await post(user, '/wallet/convert', { from: 'NGN', to: 'USD', sourceAmount: '1000000' });
    expect(converted.status).toBe(201);
    const quote = await fx.quote(user, { from: 'NGN', to: 'EUR', sourceAmount: '2000000' });
    expect(quote.status).toBe(201);
    const traded = await post(user, '/wallet/trade', { quoteId: quote.body.quoteId });
    expect(traded.status).toBe(201);
    const chargedBackId = await fund(user, '300000');
    await payments.drive();
    payments.psp.chargeback(await paymentIdOf(chargedBackId));
    await payments.drive();
    return { user, fundingId, chargedBackId, converted: converted.body, traded: traded.body, quoteId: quote.body.quoteId as string };
  };

  describe('GET /transactions reflects exactly the ledger', () => {
    it('lists every transaction with the amounts, rate, type, timestamps and status the books record', async () => {
      const { user, chargedBackId, converted, traded, quoteId } = await richUser();
      const { transactions, entries } = await booksOf(user.userId);
      const response = await history(user).expect(200);
      expect(response.body.nextCursor).toBeNull();

      // Exactly the user's transactions, in value-time order (the reference order above).
      expect(response.body.items.map((item: any) => item.reference)).toEqual(transactions.map((row) => row.reference));
      expect(transactions.map((row) => row.type).sort()).toEqual(['CONVERSION', 'CONVERSION', 'FUNDING', 'FUNDING', 'PROMOTIONAL', 'REVERSAL']);

      for (const [index, row] of transactions.entries()) {
        const item = response.body.items[index];
        expect(item).toEqual({
          reference: row.reference,
          type: row.type,
          status: expectedStatus(row.status),
          reasonCode: row.reason_code,
          legs: entries
            .filter((entry) => entry.transaction_id === row.id)
            .map(({ currency, minorUnit, direction, amount }) => ({ currency, minorUnit, direction, amount })),
          requested: null,
          rate: row.rate_display === null ? null : { rateDisplay: displayRate(dec(row.rate_display)), quoteId: row.quote_id },
          failureCode: null,
          valueTime: row.value_time.toISOString(),
          bookingTime: row.booking_time.toISOString(),
          corrects: referenceOf(transactions, row.corrects_transaction_id),
          correctedBy: referenceOf(transactions, row.corrected_by_transaction_id),
        });
      }

      // Every reason code on the wire is one of the pinned public codes (Phase 8 decision 11) — and the five Phase 8
      // codes all occur here (the Phase 10 correction codes are exercised by the admin suites).
      const onTheWire = new Set<string>(response.body.items.map((item: any) => item.reasonCode as string));
      expect([...onTheWire].every((code) => (PUBLIC_REASON_CODES as readonly string[]).includes(code))).toBe(true);
      expect(onTheWire).toEqual(new Set(['CARD_DEPOSIT', 'CHARGEBACK', 'MARKET_CONVERSION', 'QUOTED_TRADE', 'SIGNUP_DEMO_CREDIT']));

      // The rate history shows is the one the conversion response showed (stored, not recomputed).
      const byReference = new Map(response.body.items.map((item: any) => [item.reference, item]));
      expect((byReference.get(converted.reference) as any).rate).toEqual({ rateDisplay: converted.rateDisplay, quoteId: null });
      expect((byReference.get(traded.reference) as any).rate).toEqual({ rateDisplay: traded.rateDisplay, quoteId });
      expect((byReference.get(traded.reference) as any).reasonCode).toBe('QUOTED_TRADE');
      expect((byReference.get(converted.reference) as any).reasonCode).toBe('MARKET_CONVERSION');
      // A chargeback: its own REVERSAL row AND the original shows REVERSED, linked both ways.
      expect(byReference.get(`funding:${chargedBackId}`)).toMatchObject({
        status: 'REVERSED',
        correctedBy: { reference: `chargeback:${chargedBackId}`, type: 'REVERSAL' },
      });
      expect(byReference.get(`chargeback:${chargedBackId}`)).toMatchObject({
        type: 'REVERSAL',
        status: 'COMPLETED',
        reasonCode: 'CHARGEBACK',
        corrects: { reference: `funding:${chargedBackId}`, type: 'FUNDING' },
        legs: [{ currency: 'NGN', minorUnit: 2, direction: 'DEBIT', amount: '300000' }],
      });
      // Only the user's own legs: a conversion shows exactly two, never the position or revenue legs.
      expect((byReference.get(converted.reference) as any).legs.map((leg: any) => `${leg.currency} ${leg.direction}`)).toEqual(['NGN DEBIT', 'USD CREDIT']);
      // The sum of the user's legs per currency is the wallet's total.
      const wallet = (await http().get(`/${API_PREFIX}/wallet`).set('Authorization', `Bearer ${user.accessToken}`).expect(200)).body.balances;
      for (const balance of wallet) {
        const sum = response.body.items
          .flatMap((item: any) => item.legs)
          .filter((leg: any) => leg.currency === balance.currency)
          .reduce((total: bigint, leg: any) => total + (leg.direction === 'CREDIT' ? BigInt(leg.amount) : -BigInt(leg.amount)), 0n);
        expect(sum.toString()).toBe(balance.total);
      }
    });

    it('fundings that never posted: PENDING while in flight, FAILED when declined — keeping their reference once posted', async () => {
      const user = await payments.signUp();
      payments.psp.setCaptureCompletion('manual');
      const pendingId = await fund(user, '200000');
      const declinedId = await fund(user, '300000', 'tok_decline_insufficient_funds');
      await payments.drive();

      const flows = (await harness.dataSource.query(
        `SELECT flow_id::text AS flow_id, created_at, failure_code FROM funding_payments WHERE user_id = $1`,
        [user.userId],
      )) as { flow_id: string; created_at: Date; failure_code: string | null }[];
      const created = new Map(flows.map((flow) => [flow.flow_id, flow]));
      const items = (await history(user, { type: 'FUNDING' }).expect(200)).body.items as any[];
      expect(items.map((item) => item.reference).sort()).toEqual([`funding:${declinedId}`, `funding:${pendingId}`].sort());
      const pending = items.find((item) => item.reference === `funding:${pendingId}`);
      expect(pending).toEqual({
        reference: `funding:${pendingId}`,
        type: 'FUNDING',
        status: 'PENDING',
        reasonCode: null,
        legs: [],
        requested: { currency: 'NGN', minorUnit: 2, amount: '200000' },
        rate: null,
        failureCode: null,
        valueTime: created.get(pendingId)!.created_at.toISOString(),
        bookingTime: created.get(pendingId)!.created_at.toISOString(),
        corrects: null,
        correctedBy: null,
      });
      const declined = items.find((item) => item.reference === `funding:${declinedId}`);
      expect(declined).toMatchObject({ status: 'FAILED', legs: [], failureCode: created.get(declinedId)!.failure_code });
      expect(declined.failureCode).not.toBeNull();
      expect((await detail(user, `funding:${pendingId}`).expect(200)).body).toMatchObject({ status: 'PENDING', initiatedBy: 'USER', settlementTime: null });

      // It posts: the SAME reference, now COMPLETED with its leg, at the capture's value time.
      payments.psp.completeCapture(await paymentIdOf(pendingId));
      await payments.drive();
      const [posted] = (await booksOf(user.userId)).transactions.filter((row) => row.reference === `funding:${pendingId}`);
      const after = (await detail(user, `funding:${pendingId}`).expect(200)).body;
      expect(after).toMatchObject({
        status: 'COMPLETED',
        reasonCode: 'CARD_DEPOSIT',
        requested: null,
        legs: [{ currency: 'NGN', minorUnit: 2, direction: 'CREDIT', amount: '200000' }],
        valueTime: posted.value_time.toISOString(),
        // A card deposit is the user's own action (funding-flow.ts writes user:{id}); the chargeback is the system's.
        initiatedBy: 'USER',
      });
      const list = (await history(user, { type: 'FUNDING' }).expect(200)).body.items as any[];
      expect(list.filter((item) => item.reference === `funding:${pendingId}`)).toHaveLength(1);
    });
  });

  describe('GET /transactions/:reference', () => {
    it('expands legs (own only, with balanceAfter), full rate provenance and corrections both ways', async () => {
      const { user, chargedBackId, traded, quoteId } = await richUser();
      const { transactions, entries } = await booksOf(user.userId);
      const tradeRow = transactions.find((row) => row.reference === traded.reference)!;
      const body = (await detail(user, traded.reference).expect(200)).body;
      expect(body).toEqual({
        reference: tradeRow.reference,
        type: 'CONVERSION',
        status: 'COMPLETED',
        reasonCode: 'QUOTED_TRADE',
        legs: entries.filter((entry) => entry.transaction_id === tradeRow.id).map(({ transaction_id: _id, ...leg }) => leg),
        requested: null,
        rate: {
          rateDisplay: displayRate(dec(tradeRow.rate_display)),
          quoteId,
          referenceRate: displayRate(dec(tradeRow.reference_rate)),
          spreadBasisPoints: tradeRow.spread_basis_points,
          provider: tradeRow.rate_provider,
          asOf: tradeRow.rate_provider_updated_at.toISOString(),
          fetchedAt: tradeRow.rate_fetched_at.toISOString(),
          snapshotId: tradeRow.rate_snapshot_id,
        },
        failureCode: null,
        valueTime: tradeRow.value_time.toISOString(),
        bookingTime: tradeRow.booking_time.toISOString(),
        corrects: null,
        correctedBy: null,
        settlementTime: null,
        initiatedBy: 'USER',
      });
      // Nothing internal: no revenue, mid value, metadata, external reference or identities.
      const text = JSON.stringify(body);
      for (const hidden of ['revenue', 'midValue', 'metadata', 'externalReference', 'FX_POSITION', 'REVENUE', user.userId]) {
        expect(text).not.toContain(hidden);
      }
      expect(body.legs).toHaveLength(2);

      const original = (await detail(user, `funding:${chargedBackId}`).expect(200)).body;
      const reversal = (await detail(user, `chargeback:${chargedBackId}`).expect(200)).body;
      expect(original).toMatchObject({ status: 'REVERSED', correctedBy: { reference: `chargeback:${chargedBackId}`, type: 'REVERSAL' }, corrects: null });
      expect(reversal).toMatchObject({ status: 'COMPLETED', corrects: { reference: `funding:${chargedBackId}`, type: 'FUNDING' }, correctedBy: null, initiatedBy: 'SYSTEM' });
      // The chargeback's value time is the chargeback's time; its booking time is when we recorded it.
      const reversalRow = transactions.find((row) => row.reference === `chargeback:${chargedBackId}`)!;
      expect(reversal.valueTime).toBe(reversalRow.value_time.toISOString());
      expect(reversal.bookingTime).toBe(reversalRow.booking_time.toISOString());
    });

    it('accepts the colon raw or encoded, and the bare transaction id; refuses a malformed reference before querying', async () => {
      const user = await payments.signUp();
      const demo = `demo-credit:${user.userId}`;
      const [row] = (await booksOf(user.userId)).transactions;
      const raw = (await detail(user, demo).expect(200)).body;
      expect(raw.type).toBe('PROMOTIONAL');
      expect(raw.reasonCode).toBe('SIGNUP_DEMO_CREDIT');
      expect((await detail(user, encodeURIComponent(demo)).expect(200)).body).toEqual(raw);
      expect((await detail(user, row.id).expect(200)).body).toEqual(raw);
      expect((await detail(user, row.id.toUpperCase()).expect(200)).body).toEqual(raw);
      for (const bad of ['nope', 'funding:', 'Funding:' + row.id, `funding:${row.id}x`, "funding:1' OR '1'='1", 'a'.repeat(40) + ':' + row.id]) {
        const response = await detail(user, encodeURIComponent(bad));
        expect({ bad, status: response.status, code: response.body.code }).toEqual({ bad, status: 400, code: 'VALIDATION_FAILED' });
      }
    });

    it("another user's reference and an unknown one are the same 404", async () => {
      const alice = await payments.signUp();
      const bob = await payments.signUp();
      const aliceFunding = await fund(alice);
      await payments.drive();
      const unknown = `funding:${randomUUID()}`;
      const strip = (body: Record<string, unknown>) => ({ ...body, correlationId: undefined, timestamp: undefined, details: undefined });
      const foreign = await detail(bob, `funding:${aliceFunding}`);
      const missing = await detail(bob, unknown);
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe('TRANSACTION_NOT_FOUND');
      expect(strip(foreign.body)).toEqual(strip(missing.body));
      expect(foreign.body.details).toEqual({ reference: `funding:${aliceFunding}` });
      // Also by bare id, and for another user's unposted funding.
      const [aliceRow] = (await booksOf(alice.userId)).transactions;
      expect((await detail(bob, aliceRow.id)).status).toBe(404);
      const alicePending = await fund(alice, '200000');
      expect((await detail(bob, `funding:${alicePending}`)).status).toBe(404);
      expect((await detail(alice, `funding:${alicePending}`)).status).toBe(200);
      await payments.drive();
    });
  });

  describe('filters and validation', () => {
    it('filters by type, by currency (any of the user\'s own legs) and by a half-open time range', async () => {
      const { user, converted } = await richUser();
      const { transactions } = await booksOf(user.userId);
      const conversions = (await history(user, { type: 'CONVERSION' }).expect(200)).body.items;
      expect(conversions.map((item: any) => item.reference)).toEqual(transactions.filter((row) => row.type === 'CONVERSION').map((row) => row.reference));
      const usd = (await history(user, { currency: 'USD' }).expect(200)).body.items;
      expect(usd.map((item: any) => item.reference)).toEqual([converted.reference]);
      const eur = (await history(user, { currency: 'EUR', type: 'FUNDING' }).expect(200)).body.items;
      expect(eur).toEqual([]);
      // A currency the user never held: empty, not an error.
      expect((await history(user, { currency: 'GBP' }).expect(200)).body.items).toEqual([]);

      const times = transactions.map((row) => row.value_time as Date).sort((a, b) => a.getTime() - b.getTime());
      const from = times[1].toISOString();
      const to = times[times.length - 1].toISOString();
      const ranged = (await history(user, { from, to }).expect(200)).body.items;
      expect(ranged.map((item: any) => item.reference)).toEqual(
        transactions.filter((row) => row.value_time >= times[1] && row.value_time < times[times.length - 1]).map((row) => row.reference),
      );
      // The same instant written with another offset is the same bound.
      const sameInstant = new Date(times[1].getTime() + 3_600_000).toISOString().replace('Z', '+01:00');
      expect((await history(user, { from: sameInstant, to }).expect(200)).body.items).toEqual(ranged);
    });

    it('refuses bad parameters with stable codes', async () => {
      const user = await payments.signUp();
      const cases: [Record<string, string>, number, string][] = [
        [{ limit: '0' }, 400, 'VALIDATION_FAILED'],
        [{ limit: '101' }, 400, 'VALIDATION_FAILED'],
        [{ limit: '1.5' }, 400, 'VALIDATION_FAILED'],
        [{ limit: 'abc' }, 400, 'VALIDATION_FAILED'],
        [{ type: 'WITHDRAWAL' }, 400, 'VALIDATION_FAILED'],
        [{ type: 'conversion' }, 400, 'VALIDATION_FAILED'],
        [{ currency: 'usd' }, 400, 'VALIDATION_FAILED'],
        [{ currency: 'XYZ' }, 400, 'UNSUPPORTED_CURRENCY'],
        [{ from: '2026-09-29' }, 400, 'VALIDATION_FAILED'],
        [{ from: '2026-09-29T10:00:00' }, 400, 'VALIDATION_FAILED'],
        [{ from: '2026-09-29T10:00:00.1234567Z' }, 400, 'VALIDATION_FAILED'],
        [{ from: '2026-02-30T10:00:00Z' }, 400, 'VALIDATION_FAILED'],
        [{ from: '2026-09-29T10:00:00Z', to: '2026-09-29T10:00:00Z' }, 400, 'VALIDATION_FAILED'],
        [{ from: '2026-09-30T10:00:00Z', to: '2026-09-29T10:00:00Z' }, 400, 'VALIDATION_FAILED'],
        [{ sort: 'amount' }, 400, 'VALIDATION_FAILED'],
        [{ offset: '10' }, 400, 'VALIDATION_FAILED'],
        [{ cursor: 'not a cursor' }, 400, 'INVALID_CURSOR'],
        [{ cursor: Buffer.from('{"v":2}').toString('base64url') }, 400, 'INVALID_CURSOR'],
      ];
      for (const [query, status, code] of cases) {
        const response = await history(user, query);
        expect({ query, status: response.status, code: response.body.code }).toEqual({ query, status, code });
      }
    });
  });

  describe('who may read', () => {
    it('deny by default; a suspended user\'s live session is refused (no @AllowUnverified)', async () => {
      await http().get(`/${API_PREFIX}/transactions`).expect(401);
      await http().get(`/${API_PREFIX}/transactions/demo-credit:${randomUUID()}`).expect(401);
      const user = await payments.signUp();
      await history(user).expect(200);
      await harness.dataSource.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [user.userId]);
      const refused = await history(user);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('ACCOUNT_SUSPENDED');
      expect((await detail(user, `demo-credit:${user.userId}`)).body.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('the per-user limit binds across both routes (120/min), keyed by the authenticated user', async () => {
      const user = await payments.signUp();
      const other = await payments.signUp();
      await payments.clearRateLimits();
      // 60 + 60 across both routes (the global per-IP rule is 100/min: clear it in between).
      for (let index = 0; index < 60; index += 1) await history(user, { limit: '1' }).expect(200);
      await payments.clearRateLimits('global');
      for (let index = 0; index < 60; index += 1) await detail(user, `demo-credit:${user.userId}`).expect(200);
      await payments.clearRateLimits('global');
      const limited = await history(user);
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('RATE_LIMITED');
      // Another user is unaffected.
      await history(other).expect(200);
      await payments.clearRateLimits();
    });
  });

  // Last: stops the Redis container for the rest of this file.
  describe('history stays up (design §16)', () => {
    it('with the FX provider down and Redis down, history is still served from Postgres', async () => {
      const { user } = await richUser();
      const before = (await history(user).expect(200)).body;
      fx.api.failNext(...Array.from({ length: 50 }, () => ({ kind: 'server-error' as const })));
      await fx.flushSnapshotCache();
      await harness.auth!.redis.stop();
      const after = await history(user);
      expect(after.status).toBe(200);
      expect(after.body).toEqual(before);
      expect((await detail(user, before.items[0].reference)).status).toBe(200);
      fx.api.clearFaults();
    });
  });
});
