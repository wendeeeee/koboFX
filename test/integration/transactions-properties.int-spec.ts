import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { TestClock } from '../support/auth-test-doubles';
import { expectedHistory, transactionsOnForeignAccounts, userLegsByReference } from '../support/history-oracle';
import { FxHarness, HARNESS_USER_PASSWORD, LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

type Step =
  | { readonly kind: 'fund'; readonly amount: string }
  | { readonly kind: 'fund-declined'; readonly amount: string }
  | { readonly kind: 'fund-pending'; readonly amount: string }
  | { readonly kind: 'complete-pending' }
  | { readonly kind: 'convert'; readonly from: 'NGN' | 'USD'; readonly sourceAmount: string }
  | { readonly kind: 'trade'; readonly sourceAmount: string }
  | { readonly kind: 'chargeback'; readonly pick: number }
  | { readonly kind: 'advance'; readonly seconds: number };

interface Check {
  readonly limit: number;
  readonly sort: 'valueTime' | 'bookingTime';
  readonly filter: 'none' | 'type' | 'currency' | 'both';
  readonly type: 'FUNDING' | 'CONVERSION' | 'REVERSAL' | 'PROMOTIONAL';
  readonly currency: 'NGN' | 'USD' | 'EUR';
}

// Amounts steered into narrow bands: within balance, just above a small balance, far above any.
const NGN_AMOUNTS = ['100000', '500000', '2000000', '900000000'];
const USD_AMOUNTS = ['100', '700', '5000000'];
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('fund' as const), amount: fc.constantFrom('1000000', '3000000', '250000') }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('fund-declined' as const), amount: fc.constantFrom('150000', '400000') }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('fund-pending' as const), amount: fc.constantFrom('200000', '600000') }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('complete-pending' as const) }) },
  {
    weight: 4,
    arbitrary: fc.oneof(
      fc.record({ kind: fc.constant('convert' as const), from: fc.constant('NGN' as const), sourceAmount: fc.constantFrom(...NGN_AMOUNTS) }),
      fc.record({ kind: fc.constant('convert' as const), from: fc.constant('USD' as const), sourceAmount: fc.constantFrom(...USD_AMOUNTS) }),
    ),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('trade' as const), sourceAmount: fc.constantFrom(...NGN_AMOUNTS) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('chargeback' as const), pick: fc.nat(10) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('advance' as const), seconds: fc.constantFrom(1, 61, 299) }) },
);
const check: fc.Arbitrary<Check> = fc.record({
  limit: fc.oneof(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 4, max: 60 })),
  sort: fc.constantFrom('valueTime' as const, 'bookingTime' as const),
  filter: fc.constantFrom('none' as const, 'type' as const, 'currency' as const, 'both' as const),
  type: fc.constantFrom('FUNDING' as const, 'CONVERSION' as const, 'REVERSAL' as const, 'PROMOTIONAL' as const),
  currency: fc.constantFrom('NGN' as const, 'USD' as const, 'EUR' as const),
});

const PROPERTY_TIME_LIMIT_MILLISECONDS = 420_000;

/**
 * History as a property of the books (PHASE8_PLAN §F), through the HTTP pipeline. For any steered
 * sequence of real fundings (posted, declined, pending), market conversions, quoted trades,
 * chargebacks and clock advances — AFTER EVERY STEP — paging `GET /transactions` to the end with a
 * random limit, sort and filter yields exactly the oracle's rows, each once, in order; the user's
 * legs per currency sum to `GET /wallet`'s total; every item's legs are its ledger entries; and
 * no transaction sits on another user's account. Every interesting path must have run.
 */
describe('Transaction history properties (integration)', () => {
  let harness: LedgerHarness;
  let fx: FxHarness;
  let payments: PaymentsHarness;
  let clock: TestClock;

  beforeAll(async () => {
    harness = await startLedgerHarness(
      {
        DEMO_CREDIT_NGN_MINOR: '5000000',
        CONVERSION_LIMITS: JSON.stringify({
          NGN: { maximum: '10000000000', dailyMaximum: '100000000000' },
          USD: { maximum: '10000000', dailyMaximum: '100000000' },
          EUR: { maximum: '10000000', dailyMaximum: '100000000' },
          GBP: { maximum: '10000000', dailyMaximum: '100000000' },
        }),
      },
      { fx: true },
    );
    fx = harness.fx!;
    payments = harness.payments!;
    clock = harness.auth!.clock;
  });
  afterAll(async () => harness?.close());

  const http = () => request(harness.auth!.app.getHttpServer());
  const bearer = (user: SignedUpUser) => `Bearer ${user.accessToken}`;
  const post = (user: SignedUpUser, path: string, body: Record<string, unknown>) =>
    http().post(`/${API_PREFIX}${path}`).set('Authorization', bearer(user)).set('Idempotency-Key', randomUUID()).send(body);

  it('after every step: history is exactly the books, in order, each row once (and every path runs)', async () => {
    const seen = new Map<string, number>();
    const see = (path: string) => seen.set(path, (seen.get(path) ?? 0) + 1);

    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(step, check), { minLength: 6, maxLength: 12 }), async (sequence) => {
        clock.advance(86_400_000);
        await fx.resetRedisState();
        await fx.warm();
        await payments.clearRateLimits();
        payments.psp.setCaptureCompletion('immediate');
        let user = await payments.signUp();
        let authenticatedAt = clock.now().getTime();
        const pendingPayments: string[] = [];

        const reauthenticate = async () => {
          // Access tokens live 900s on the clock: re-authenticate well before (before steps AND checks).
          if (clock.now().getTime() - authenticatedAt > 400_000) {
            user = await reLogin(user);
            authenticatedAt = clock.now().getTime();
          }
        };

        for (const [action, verify] of sequence) {
          await reauthenticate();
          await payments.clearRateLimits();
          await perform(user, action, pendingPayments, see);
          await reauthenticate();
          await verifyHistory(user, verify, see);
        }
      }),
      { numRuns: 12, endOnFailure: true, interruptAfterTimeLimit: PROPERTY_TIME_LIMIT_MILLISECONDS, markInterruptAsFailure: true },
    );

    const required = [
      'fund', 'fund-declined', 'fund-pending', 'complete-pending', 'convert-201', 'convert-409', 'trade-201', 'chargeback', 'advance',
      'filter:none', 'filter:type', 'filter:currency', 'filter:both', 'sort:valueTime', 'sort:bookingTime', 'multi-page', 'item:PENDING', 'item:FAILED', 'item:REVERSED',
    ];
    expect({ missing: required.filter((path) => !seen.has(path)), seen: Object.fromEntries(seen) }).toEqual({ missing: [], seen: expect.anything() });
  }, PROPERTY_TIME_LIMIT_MILLISECONDS + 120_000);

  /** A fresh session for the same user (the history must stay one user's across the whole sequence). */
  async function reLogin(user: SignedUpUser): Promise<SignedUpUser> {
    await payments.clearRateLimits();
    const response = await http().post(`/${API_PREFIX}/auth/login`).send({ email: user.email, password: HARNESS_USER_PASSWORD }).expect(200);
    return { ...user, accessToken: response.body.tokens.access.token };
  }

  async function perform(user: SignedUpUser, action: Step, pendingPayments: string[], see: (path: string) => void): Promise<void> {
    switch (action.kind) {
      case 'fund':
      case 'fund-declined':
      case 'fund-pending': {
        payments.psp.setCaptureCompletion(action.kind === 'fund-pending' ? 'manual' : 'immediate');
        const token = action.kind === 'fund-declined' ? 'tok_decline_insufficient_funds' : 'tok_success_visa';
        const response = await payments.fund(user, { amount: action.amount, currency: 'NGN', paymentMethodToken: token });
        expect(response.status).toBe(202);
        await payments.drive();
        payments.psp.setCaptureCompletion('immediate');
        if (action.kind === 'fund-pending') {
          const [{ provider_payment_id: paymentId }] = (await harness.dataSource.query(
            `SELECT provider_payment_id FROM funding_payments WHERE flow_id = $1`,
            [response.body.fundingId],
          )) as { provider_payment_id: string }[];
          pendingPayments.push(paymentId);
        }
        see(action.kind);
        return;
      }
      case 'complete-pending':
        for (const paymentId of pendingPayments.splice(0)) payments.psp.completeCapture(paymentId);
        await payments.drive();
        see(action.kind);
        return;
      case 'convert': {
        const to = action.from === 'NGN' ? 'USD' : 'NGN';
        const response = await post(user, '/wallet/convert', { from: action.from, to, sourceAmount: action.sourceAmount });
        expect([201, 409]).toContain(response.status);
        if (response.status === 409) expect(['INSUFFICIENT_FUNDS', 'FUNDS_RESERVED']).toContain(response.body.code);
        see(`convert-${response.status}`);
        return;
      }
      case 'trade': {
        const quote = await fx.quote(user, { from: 'NGN', to: 'EUR', sourceAmount: action.sourceAmount });
        expect(quote.status).toBe(201);
        const response = await post(user, '/wallet/trade', { quoteId: quote.body.quoteId });
        expect([201, 409]).toContain(response.status);
        see(`trade-${response.status}`);
        return;
      }
      case 'chargeback': {
        const candidates = (await harness.dataSource.query(
          `SELECT provider_payment_id FROM funding_payments
            WHERE user_id = $1 AND funding_transaction_id IS NOT NULL AND chargeback_transaction_id IS NULL
            ORDER BY created_at`,
          [user.userId],
        )) as { provider_payment_id: string }[];
        if (candidates.length === 0) return;
        payments.psp.chargeback(candidates[action.pick % candidates.length].provider_payment_id);
        await payments.drive();
        see('chargeback');
        return;
      }
      case 'advance':
        clock.advance(action.seconds * 1000);
        await fx.warm();
        see('advance');
        return;
    }
  }

  async function verifyHistory(user: SignedUpUser, verify: Check, see: (path: string) => void): Promise<void> {
    const query: Record<string, string> = { sort: verify.sort };
    if (verify.filter === 'type' || verify.filter === 'both') query.type = verify.type;
    if (verify.filter === 'currency' || verify.filter === 'both') query.currency = verify.currency;
    see(`filter:${verify.filter}`);
    see(`sort:${verify.sort}`);

    // 1. Paging to the end yields exactly the oracle's rows, each once, in order.
    const got = await traverse(user, query, verify.limit, see);
    const expected = await expectedHistory(harness.dataSource, user.userId, query);
    expect({ query, limit: verify.limit, got: got.map((item) => item.reference) }).toEqual({ query, limit: verify.limit, got: expected });

    // 2. The whole history (one page): every item's legs are its ledger entries; per currency the legs sum to the wallet.
    const all = await traverse(user, {}, 100, () => undefined);
    const legs = await userLegsByReference(harness.dataSource, user.userId);
    for (const item of all) {
      expect({ reference: item.reference, legs: item.legs }).toEqual({ reference: item.reference, legs: legs.get(item.reference) ?? [] });
      see(`item:${item.status}`);
    }
    const wallet = (await http().get(`/${API_PREFIX}/wallet`).set('Authorization', bearer(user)).expect(200)).body.balances as { currency: string; total: string }[];
    for (const balance of wallet) {
      const sum = all
        .flatMap((item) => item.legs)
        .filter((leg) => leg.currency === balance.currency)
        .reduce((total, leg) => total + (leg.direction === 'CREDIT' ? BigInt(leg.amount) : -BigInt(leg.amount)), 0n);
      expect({ currency: balance.currency, sum: sum.toString() }).toEqual({ currency: balance.currency, sum: balance.total });
    }
    // 3. No transaction sits on an account of a user it does not belong to.
    expect(await transactionsOnForeignAccounts(harness.dataSource)).toEqual([]);
  }

  interface Item {
    readonly reference: string;
    readonly status: string;
    readonly legs: { currency: string; minorUnit: number; direction: string; amount: string }[];
  }

  async function traverse(user: SignedUpUser, query: Record<string, string>, limit: number, see: (path: string) => void): Promise<Item[]> {
    await payments.clearRateLimits();
    const items: Item[] = [];
    let cursor: string | null = null;
    for (let pages = 1; ; pages += 1) {
      if (pages > 300) throw new Error('pagination does not terminate');
      const response: request.Response = await http()
        .get(`/${API_PREFIX}/transactions`)
        .query({ ...query, limit: String(limit), ...(cursor ? { cursor } : {}) })
        .set('Authorization', bearer(user));
      expect(response.status).toBe(200);
      items.push(...(response.body.items as Item[]));
      cursor = response.body.nextCursor;
      if (cursor === null) {
        if (pages > 1) see('multi-page');
        return items;
      }
      expect(response.body.items).toHaveLength(limit);
    }
  }
});
