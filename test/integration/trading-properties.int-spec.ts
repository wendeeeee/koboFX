import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { dec, majorToExactMinor, minorToMajorDecimal } from '../../src/common/money';
import { RECORDED_RATES } from '../../src/mock-exchange-rate-api/mock-exchange-rate-api';
import { TestClock } from '../support/auth-test-doubles';
import { FxHarness, LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

const CURRENCIES = ['NGN', 'USD', 'EUR'] as const;
type Currency = (typeof CURRENCIES)[number];
const PASSWORD = 'correct horse battery staple';

type Action =
  | { readonly kind: 'fund'; readonly user: 0 | 1; readonly currency: Currency; readonly amount: bigint }
  | { readonly kind: 'convert'; readonly user: 0 | 1; readonly pair: readonly [Currency, Currency]; readonly byTarget: boolean; readonly band: 'fits' | 'above' | 'tiny' | 'any'; readonly amount: bigint }
  | { readonly kind: 'quote'; readonly user: 0 | 1; readonly pair: readonly [Currency, Currency]; readonly band: 'fits' | 'above'; readonly amount: bigint }
  | { readonly kind: 'trade'; readonly user: 0 | 1; readonly pick: number; readonly reuse: boolean }
  | { readonly kind: 'publish'; readonly ngnPerMille: number }
  | { readonly kind: 'advance'; readonly seconds: number };

const user = fc.constantFrom(0 as const, 1 as const);
const currency = fc.constantFrom(...CURRENCIES);
/** Pair minimums (Phase 6 seed): ₦1,000 / $1 / €1. */
const MINIMUM: Record<Currency, bigint> = { NGN: 100_000n, USD: 100n, EUR: 100n };
/** Mostly real pairs; now and then the same currency (a refusal path). */
const pair = fc.oneof(
  { weight: 9, arbitrary: fc.constantFrom(...CURRENCIES.flatMap((from) => CURRENCIES.filter((to) => to !== from).map((to) => [from, to] as const))) },
  { weight: 1, arbitrary: currency.map((code) => [code, code] as const) },
);

/** Steered: amounts land in narrow bands (fits the balance, just above it, below the pair minimum) so every refusal path runs. */
const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('fund' as const), user, currency, amount: fc.bigInt({ min: 1n, max: 50_000_000n }) }) },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant('convert' as const),
      user,
      pair,
      byTarget: fc.boolean(),
      band: fc.constantFrom('fits' as const, 'fits' as const, 'above' as const, 'tiny' as const, 'any' as const),
      amount: fc.bigInt({ min: 1n, max: 30_000_000n }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('quote' as const),
      user,
      pair,
      band: fc.constantFrom('fits' as const, 'above' as const),
      amount: fc.bigInt({ min: 1n, max: 30_000_000n }),
    }),
  },
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('trade' as const), user, pick: fc.nat(), reuse: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('publish' as const), ngnPerMille: fc.integer({ min: 970, max: 1030 }) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('advance' as const), seconds: fc.constantFrom(1, 5, 29, 31, 61, 421, 421) }) },
);

/**
 * Trading as a whole (PHASE7_PLAN §E) through the HTTP pipeline, rate limits cleared: for
 * any steered sequence of funding, conversions, quotes, trades, rate publications and clock
 * advances (forward only), after EVERY step:
 *
 * - each user's balances equal the model (built only from the amounts the responses report,
 *   so a posting the response doesn't describe shows up), nothing is reserved, and no
 *   conversion drives a balance negative;
 * - the books are clean (per-currency balance, accounting equation, cached = Σ entries,
 *   continuity, hash chain, reserved = Σ ACTIVE);
 * - every conversion's revenue = mid value − credit, and |exact mid value − booked| ≤ ½ unit;
 * - every command replayed with its key has zero additional effect and an identical body.
 *
 * The run then names any interesting path that never occurred.
 */
describe('Trading properties (integration)', () => {
  let harness: LedgerHarness;
  let fx: FxHarness;
  let payments: PaymentsHarness;
  let clock: TestClock;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { fx: true });
    fx = harness.fx!;
    payments = harness.payments!;
    clock = harness.auth!.clock;
    await fx.warm();
  });
  afterAll(async () => {
    await harness?.close();
  });

  const http = () => request(harness.auth!.app.getHttpServer());

  interface Trader {
    account: SignedUpUser;
    token: string;
    tokenIssuedAt: number;
    balances: Map<string, bigint>;
  }

  async function signIn(trader: Trader): Promise<void> {
    await payments.clearRateLimits();
    const response = await http().post(`/${API_PREFIX}/auth/login`).send({ email: trader.account.email, password: PASSWORD }).expect(200);
    trader.token = response.body.tokens.access.token;
    trader.tokenIssuedAt = clock.now().getTime();
  }

  /**
   * Access tokens live 900s on the clock and one step advances it by up to 482s (421 + a
   * publication's 61): re-authenticate any session older than 400s, before a step and before
   * its checks.
   */
  async function refreshSessions(traders: Trader[]): Promise<void> {
    for (const trader of traders) if (clock.now().getTime() - trader.tokenIssuedAt > 400_000) await signIn(trader);
  }

  async function credit(trader: Trader, code: Currency, amountMinor: bigint): Promise<void> {
    const [{ id: walletId }] = (await harness.dataSource.query(`SELECT id FROM wallets WHERE user_id = $1`, [trader.account.userId])) as { id: string }[];
    const account = await harness.chartOfAccounts.openUserAccount(walletId, code);
    await harness.fund({ userId: trader.account.userId, walletId, accountId: account.id, currency: code }, amountMinor);
    trader.balances.set(code, (trader.balances.get(code) ?? 0n) + amountMinor);
  }

  /** POST with a key, then replay it: identical status and bytes, and nothing else changed. */
  async function sendTwice(trader: Trader, path: string, body: Record<string, unknown>) {
    const key = randomUUID();
    const send = () => http().post(`/${API_PREFIX}${path}`).set('Authorization', `Bearer ${trader.token}`).set('Idempotency-Key', key).send(body);
    const first = await send();
    const before = await harness.snapshot();
    const replay = await send();
    if (first.status < 500) {
      // A stored outcome replays byte for byte.
      expect({ path, status: replay.status, text: replay.text }).toEqual({ path, status: first.status, text: first.text });
    } else {
      // A transient refusal (503) is never stored: the replay is processed afresh — same refusal,
      // its own correlation id and timestamp.
      const essence = (body: Record<string, unknown>) => ({ ...body, correlationId: undefined, timestamp: undefined });
      expect({ path, status: replay.status, body: essence(replay.body) }).toEqual({ path, status: first.status, body: essence(first.body) });
    }
    // Either way the replay writes nothing.
    expect(await harness.snapshot()).toEqual(before);
    return first;
  }

  async function assertConversionArithmetic(transactionId: string): Promise<void> {
    const [row] = (await harness.dataSource.query(
      `SELECT source_currency, source_amount_minor::text AS source, target_currency, target_amount_minor::text AS target,
              reference_rate::text AS mid, source_minor.minor_unit AS source_minor_unit, target_minor.minor_unit AS target_minor_unit
         FROM transactions
         JOIN currencies source_minor ON source_minor.code = transactions.source_currency
         JOIN currencies target_minor ON target_minor.code = transactions.target_currency
        WHERE transactions.id = $1`,
      [transactionId],
    )) as { source_currency: string; source: string; target_currency: string; target: string; mid: string; source_minor_unit: number; target_minor_unit: number }[];
    const entries = (await harness.dataSource.query(
      `SELECT accounts.code, ledger_entries.direction, ledger_entries.amount_minor::text AS amount
         FROM ledger_entries JOIN accounts ON accounts.id = ledger_entries.account_id WHERE ledger_entries.transaction_id = $1`,
      [transactionId],
    )) as { code: string; direction: string; amount: string }[];
    const target = row.target_currency.trim();
    const midValue = BigInt(entries.find((entry) => entry.code === `FX_POSITION:${target}` && entry.direction === 'DEBIT')!.amount);
    const revenue = BigInt(entries.find((entry) => entry.code === `REVENUE:FX_SPREAD:${target}`)?.amount ?? '0');
    expect(midValue - BigInt(row.target)).toBe(revenue);
    expect(revenue >= 0n).toBe(true);
    const exactMid = majorToExactMinor(minorToMajorDecimal(BigInt(row.source), row.source_minor_unit).times(dec(row.mid)), row.target_minor_unit);
    // The stored mid is exact to 34 digits: allow ½ unit plus that representation error.
    expect(exactMid.minus(midValue.toString()).abs().lte('0.5000001')).toBe(true);
  }

  it('invariants hold after every step of any generated sequence (and every path runs)', async () => {
    const seen = new Map<string, number>();
    const see = (path: string) => seen.set(path, (seen.get(path) ?? 0) + 1);

    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 15, maxLength: 30 }), async (actions) => {
        clock.advance(86_400_000);
        await fx.resetRedisState();
        fx.api.clearFaults();
        await fx.warm();
        let ngnRate = dec(RECORDED_RATES.NGN);
        const traders: Trader[] = [];
        for (let index = 0; index < 2; index += 1) {
          const account = await payments.signUp();
          const trader: Trader = { account, token: account.accessToken, tokenIssuedAt: clock.now().getTime(), balances: new Map() };
          // Seed every currency, so conversions can succeed from the first step.
          await credit(trader, 'NGN', 20_000_000n);
          await credit(trader, 'USD', 50_000n);
          await credit(trader, 'EUR', 50_000n);
          traders.push(trader);
        }
        const quotes: { owner: number; quoteId: string }[] = [];
        const traded: { owner: number; quoteId: string }[] = [];

        for (const step of actions) {
          await payments.clearRateLimits();
          await refreshSessions(traders);
          const transactionsBefore = ((await harness.dataSource.query(`SELECT count(*)::int AS n FROM transactions WHERE type = 'CONVERSION'`)) as { n: number }[])[0].n;

          switch (step.kind) {
            case 'fund':
              await credit(traders[step.user], step.currency, step.amount);
              see('fund');
              break;
            case 'convert':
            case 'quote': {
              const trader = traders[step.user];
              const [from, to] = step.pair;
              const available = trader.balances.get(from) ?? 0n;
              const byTarget = step.kind === 'convert' && step.byTarget;
              let amount = step.amount;
              // fits: between the pair minimum and what is available (the whole balance at most).
              if (!byTarget && step.band === 'fits' && available >= MINIMUM[from]) amount = MINIMUM[from] + (step.amount % (available - MINIMUM[from] + 1n));
              if (!byTarget && step.band === 'above') amount = available + 1n + (step.amount % 1_000n);
              if (step.kind === 'convert' && step.band === 'tiny') amount = 1n + (step.amount % 50n);
              const body = { from, to, [byTarget ? 'targetAmount' : 'sourceAmount']: amount.toString() };
              const response = await sendTwice(trader, step.kind === 'convert' ? '/wallet/convert' : '/fx/quotes', body);
              see(`${step.kind}-${response.status === 201 ? '201' : response.body.code}`);
              if (response.status === 201 && step.kind === 'quote') quotes.push({ owner: step.user, quoteId: response.body.quoteId });
              if (response.status === 201 && step.kind === 'convert') applyConversion(trader, response.body);
              break;
            }
            case 'trade': {
              const trader = traders[step.user];
              // reuse: one of this trader's already-traded quotes (the used-quote path); else any quote, either owner's.
              const own = traded.filter((quote) => quote.owner === step.user);
              const pool = step.reuse && own.length > 0 ? own : quotes;
              const chosen = pool.length > 0 ? pool[step.pick % pool.length] : undefined;
              const response = await sendTwice(trader, '/wallet/trade', { quoteId: chosen?.quoteId ?? randomUUID() });
              see(`trade-${response.status === 201 ? '201' : response.body.code}`);
              if (response.status === 201) {
                applyConversion(trader, response.body);
                traded.push({ owner: step.user, quoteId: response.body.quoteId });
              }
              break;
            }
            case 'publish': {
              clock.advance(61_000);
              ngnRate = dec(RECORDED_RATES.NGN).times(step.ngnPerMille).div(1000);
              fx.publishFresh({ ...RECORDED_RATES, NGN: ngnRate.toFixed(6) });
              const outcome = await fx.fetcher.fetch('POLL');
              fx.rates.forgetLocalCopy();
              see(`publish-${outcome.kind}`);
              break;
            }
            case 'advance':
              clock.advance(step.seconds * 1000);
              see(`advance-${step.seconds}`);
              break;
          }

          // After EVERY step: the model, holds, the books, and each new conversion's arithmetic.
          await refreshSessions(traders);
          for (const trader of traders) {
            const wallet = (await http().get(`/${API_PREFIX}/wallet`).set('Authorization', `Bearer ${trader.token}`).expect(200)).body.balances as {
              currency: string;
              total: string;
              reserved: string;
            }[];
            const actual = Object.fromEntries(wallet.filter((row) => row.total !== '0').map((row) => [row.currency, row.total]));
            const expected = Object.fromEntries([...trader.balances].filter(([, amount]) => amount !== 0n).map(([code, amount]) => [code, amount.toString()]));
            expect(actual).toEqual(expected);
            expect(wallet.every((row) => row.reserved === '0' && !row.total.startsWith('-'))).toBe(true);
          }
          await harness.expectCleanBooks();
          const fresh = (await harness.dataSource.query(
            `SELECT id FROM transactions WHERE type = 'CONVERSION' ORDER BY booking_time DESC, id LIMIT $1`,
            [((await harness.dataSource.query(`SELECT count(*)::int AS n FROM transactions WHERE type = 'CONVERSION'`)) as { n: number }[])[0].n - transactionsBefore],
          )) as { id: string }[];
          for (const { id } of fresh) await assertConversionArithmetic(id);
        }
      }),
      { numRuns: 10 },
    );

    const required = [
      'convert-201', 'convert-INSUFFICIENT_FUNDS', 'convert-AMOUNT_TOO_SMALL', 'convert-SAME_CURRENCY', 'convert-FX_RATE_STALE',
      'quote-201', 'trade-201', 'trade-QUOTE_EXPIRED', 'trade-QUOTE_ALREADY_USED', 'trade-QUOTE_NOT_FOUND', 'trade-INSUFFICIENT_FUNDS',
      'publish-ACCEPTED',
    ];
    expect({ missing: required.filter((path) => !seen.has(path)), seen: Object.fromEntries(seen) }).toEqual({ missing: [], seen: expect.anything() });

    function applyConversion(trader: Trader, body: { debited: { currency: string; amount: string }; credited: { currency: string; amount: string } }): void {
      const debited = BigInt(body.debited.amount);
      const before = trader.balances.get(body.debited.currency) ?? 0n;
      // A conversion never makes a balance negative: the gate saw it first.
      expect(before >= debited).toBe(true);
      trader.balances.set(body.debited.currency, before - debited);
      trader.balances.set(body.credited.currency, (trader.balances.get(body.credited.currency) ?? 0n) + BigInt(body.credited.amount));
    }
    // Every step re-checks the whole book and replays its command: slow by design.
  }, 1_200_000);
});
