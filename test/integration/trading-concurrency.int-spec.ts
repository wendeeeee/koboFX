import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { DomainError } from '../../src/common/errors';
import { ServedSnapshot } from '../../src/modules/fx/fx-rate.service';
import { ConvertService } from '../../src/modules/trading/convert.service';
import { TradeService } from '../../src/modules/trading/trade.service';
import { TestClock } from '../support/auth-test-doubles';
import { FxHarness, LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

const POOL_SIZE = 20;

/**
 * Concurrency (design §11, PHASE7_PLAN §D.11) on a real pool. Each test issues the commands
 * that should contend back to back, on a warmed pool (a cold pool silently serialises), and
 * each was shown able to fail with `scripts/mutation-check.py`. One internal bucket, so
 * every conversion meets on the same `FX_POSITION` rows.
 *
 * §11's "100 × ₦800 against ₦1,000" is below the NGN pair minimum (₦1,000, Phase 6), so this
 * suite lowers the NGN→USD minimum to ₦100 in its own database.
 */
describe('Trading concurrency (integration)', () => {
  let harness: LedgerHarness;
  let fx: FxHarness;
  let payments: PaymentsHarness;
  let clock: TestClock;
  let owner: Client;
  let convertService: ConvertService;
  let tradeService: TradeService;

  beforeAll(async () => {
    harness = await startLedgerHarness({ DB_POOL_MAX: String(POOL_SIZE), LEDGER_INTERNAL_BUCKETS: '1' }, { fx: true });
    fx = harness.fx!;
    payments = harness.payments!;
    clock = harness.auth!.clock;
    owner = await harness.db.ownerClient();
    await owner.query(`UPDATE currency_pairs SET minimum_source_amount_minor = 10000 WHERE source_currency_code = 'NGN' AND target_currency_code = 'USD'`);
    convertService = harness.moduleRef.get(ConvertService);
    tradeService = harness.moduleRef.get(TradeService);
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
  afterEach(async () => {
    await harness.expectCleanBooks();
  });

  const http = () => request(harness.auth!.app.getHttpServer());
  const warmPool = () => Promise.all(Array.from({ length: POOL_SIZE }, () => harness.dataSource.query('SELECT pg_sleep(0.2)')));
  const codeOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
      return 'POSTED';
    } catch (error) {
      return error instanceof DomainError ? error.code : String(error);
    }
  };
  const tally = (outcomes: string[]) => outcomes.reduce<Record<string, number>>((counts, outcome) => ({ ...counts, [outcome]: (counts[outcome] ?? 0) + 1 }), {});

  const credit = async (user: SignedUpUser, currency: string, amountMinor: bigint) => {
    const [{ id: walletId }] = (await harness.dataSource.query(`SELECT id FROM wallets WHERE user_id = $1`, [user.userId])) as { id: string }[];
    const account = await harness.chartOfAccounts.openUserAccount(walletId, currency);
    await harness.fund({ userId: user.userId, walletId, accountId: account.id, currency }, amountMinor);
    return account.id;
  };
  const prepared = async (): Promise<ServedSnapshot> => (await fx.rates.prepareExecutable()) as ServedSnapshot;
  const convertDirect = (user: SignedUpUser, from: string, to: string, sourceAmount: string, snapshot: ServedSnapshot) =>
    convertService.convert(user.userId, { from, to, sourceAmount }, snapshot, undefined);
  const conversionsOf = async (userId: string) =>
    ((await harness.dataSource.query(`SELECT count(*)::int AS n FROM transactions WHERE user_id = $1 AND type = 'CONVERSION'`, [userId])) as { n: number }[])[0].n;
  const activeReservationsOn = async (accountId: string) =>
    ((await harness.dataSource.query(`SELECT count(*)::int AS n FROM reservations WHERE account_id = $1 AND status = 'ACTIVE'`, [accountId])) as {
      n: number;
    }[])[0].n;

  /**
   * Open the target account first: otherwise every racer inserts it, and all but one wait on
   * that uncommitted insert until the winner commits — the race would never reach the source
   * account's row lock (a mutant dropping FOR UPDATE survived exactly that way).
   */
  const openAccount = async (user: SignedUpUser, currency: string) => {
    const [{ id: walletId }] = (await harness.dataSource.query(`SELECT id FROM wallets WHERE user_id = $1`, [user.userId])) as { id: string }[];
    await harness.chartOfAccounts.openUserAccount(walletId, currency);
  };

  it('§11: 100 parallel conversions of ₦800 against ₦1,000 — exactly one succeeds, ₦200 left, nothing orphaned', async () => {
    const alice = await payments.signUp();
    const accountId = await credit(alice, 'NGN', 100_000n);
    await openAccount(alice, 'USD');
    const snapshot = await prepared();
    await warmPool();
    const outcomes = await Promise.all(Array.from({ length: 100 }, () => codeOf(convertDirect(alice, 'NGN', 'USD', '80000', snapshot))));
    expect(tally(outcomes)).toEqual({ POSTED: 1, INSUFFICIENT_FUNDS: 99 });
    expect(await harness.balanceOf(accountId)).toBe(20_000n);
    expect(await harness.reservedOf(accountId)).toBe(0n);
    expect(await activeReservationsOn(accountId)).toBe(0);
    expect(await conversionsOf(alice.userId)).toBe(1);
    const [{ n: flows }] = (await harness.dataSource.query(`SELECT count(*)::int AS n FROM flow_instances WHERE user_id = $1 AND flow_type = 'CONVERSION'`, [
      alice.userId,
    ])) as { n: number }[];
    expect(flows).toBe(1);
  });

  it('§11 through the barrier: 20 parallel HTTP conversions of ₦800 against ₦1,000 — one 201, nineteen 409', async () => {
    const alice = await payments.signUp();
    const accountId = await credit(alice, 'NGN', 100_000n);
    await openAccount(alice, 'USD');
    await warmPool();
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        http()
          .post(`/${API_PREFIX}/wallet/convert`)
          .set('Authorization', `Bearer ${alice.accessToken}`)
          .set('Idempotency-Key', randomUUID())
          .send({ from: 'NGN', to: 'USD', sourceAmount: '80000' }),
      ),
    );
    expect(tally(responses.map((response) => `${response.status} ${response.body.code ?? 'POSTED'}`))).toEqual({
      '201 POSTED': 1,
      '409 INSUFFICIENT_FUNDS': 19,
    });
    expect(await harness.balanceOf(accountId)).toBe(20_000n);
    expect(await harness.reservedOf(accountId)).toBe(0n);
  });

  it('opposite directions on the same FX_POSITION rows (NGN→USD vs USD→NGN, interleaved) never deadlock', async () => {
    const alice = await payments.signUp();
    const bob = await payments.signUp();
    await credit(alice, 'NGN', 2_000_000n);
    await credit(bob, 'USD', 2_000n);
    const snapshot = await prepared();
    await warmPool();
    const commands: Promise<string>[] = [];
    for (let index = 0; index < 20; index += 1) {
      commands.push(codeOf(convertDirect(alice, 'NGN', 'USD', '100000', snapshot)));
      commands.push(codeOf(convertDirect(bob, 'USD', 'NGN', '100', snapshot)));
    }
    expect(tally(await Promise.all(commands))).toEqual({ POSTED: 40 });
    expect(await conversionsOf(alice.userId)).toBe(20);
    expect(await conversionsOf(bob.userId)).toBe(20);
  });

  it('20 parallel trades of one quote: one posting, nineteen QUOTE_ALREADY_USED', async () => {
    const alice = await payments.signUp();
    await credit(alice, 'NGN', 10_000_000n);
    const quote = await fx.quote(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000' }).expect(201);
    await warmPool();
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => codeOf(tradeService.trade(alice.userId, { quoteId: quote.body.quoteId }, undefined))));
    expect(tally(outcomes)).toEqual({ POSTED: 1, QUOTE_ALREADY_USED: 19 });
    expect(await conversionsOf(alice.userId)).toBe(1);
  });

  it('a trade racing its own replay (same key): one posting; the loser replays the identical bytes or is told it is in progress', async () => {
    const alice = await payments.signUp();
    await credit(alice, 'NGN', 10_000_000n);
    for (let round = 0; round < 5; round += 1) {
      const quote = await fx.quote(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000' }).expect(201);
      const key = randomUUID();
      const send = () =>
        http().post(`/${API_PREFIX}/wallet/trade`).set('Authorization', `Bearer ${alice.accessToken}`).set('Idempotency-Key', key).send({ quoteId: quote.body.quoteId });
      await warmPool();
      const [first, second] = await Promise.all([send(), send()]);
      const posted = [first, second].filter((response) => response.status === 201 && response.headers['idempotent-replayed'] === undefined);
      expect(posted).toHaveLength(1);
      const other = posted[0] === first ? second : first;
      if (other.status === 201) expect(other.text).toBe(posted[0].text);
      else expect([other.status, other.body.code]).toEqual([409, 'REQUEST_IN_PROGRESS']);
      // Once settled, the key always replays the original.
      const replay = await send();
      expect([replay.status, replay.text, replay.headers['idempotent-replayed']]).toEqual([201, posted[0].text, 'true']);
    }
    expect(await conversionsOf(alice.userId)).toBe(5);
  });

  it('a convert racing a trade on an account that covers only one: exactly one posts', async () => {
    const alice = await payments.signUp();
    const accountId = await credit(alice, 'NGN', 1n);
    const snapshot = await prepared();
    for (let round = 0; round < 5; round += 1) {
      await credit(alice, 'NGN', 100_000n);
      const quote = await fx.quote(alice, { from: 'NGN', to: 'USD', sourceAmount: '100000' }).expect(201);
      await warmPool();
      const outcomes = await Promise.all([
        codeOf(convertDirect(alice, 'NGN', 'USD', '100000', snapshot)),
        codeOf(tradeService.trade(alice.userId, { quoteId: quote.body.quoteId }, undefined)),
      ]);
      expect(outcomes.sort()).toEqual(['INSUFFICIENT_FUNDS', 'POSTED']);
    }
    expect(await harness.balanceOf(accountId)).toBe(1n);
    expect(await conversionsOf(alice.userId)).toBe(5);
  });

  /**
   * The two orders, then the race. Balances move by relative UPDATEs, so a conversion approved on
   * a stale read ends exactly like "conversion first, then chargeback": the end state cannot tell
   * the orders apart, and a race alone proves only "no deadlock, books clean". The sequential
   * rounds pin what each order must produce — above all that a chargeback after the money was
   * spent is recorded, driving the balance negative, never refused or clamped.
   */
  it('a convert and a chargeback of the funding that paid for it: either order, or racing — no deadlock, never clamped', async () => {
    for (const order of ['conversion-first', 'chargeback-first', 'racing', 'racing'] as const) {
      const alice = await payments.signUp();
      const funded = await payments.fund(alice, { amount: '100000', currency: 'NGN', paymentMethodToken: 'tok_success_visa' });
      expect(funded.status).toBe(202);
      await payments.drive();
      for (const event of payments.psp.pendingWebhooks()) payments.psp.drop(event.id);
      const [{ provider_payment_id: paymentId, account_id: accountId }] = (await harness.dataSource.query(
        `SELECT provider_payment_id, account_id FROM funding_payments WHERE flow_id = $1`,
        [funded.body.fundingId],
      )) as { provider_payment_id: string; account_id: string }[];
      expect(await harness.balanceOf(accountId)).toBe(100_000n);

      const snapshot = await prepared();
      const conversion = () => codeOf(convertDirect(alice, 'NGN', 'USD', '100000', snapshot));
      const chargeback = async () => {
        await payments.psp.deliverAll();
        await payments.processor.processDue(100);
      };
      payments.psp.chargeback(paymentId);
      await warmPool();
      let outcome: string;
      if (order === 'conversion-first') {
        outcome = await conversion();
        await chargeback();
        expect(outcome).toBe('POSTED');
      } else if (order === 'chargeback-first') {
        await chargeback();
        outcome = await conversion();
        expect(outcome).toBe('INSUFFICIENT_FUNDS');
      } else {
        [outcome] = await Promise.all([conversion(), chargeback()]);
      }
      await payments.drive();
      const [{ state }] = (await harness.dataSource.query(`SELECT state FROM flow_instances WHERE id = $1`, [funded.body.fundingId])) as { state: string }[];
      expect({ order, state }).toEqual({ order, state: 'REVERSED' });
      const balance = await harness.balanceOf(accountId);
      if (outcome === 'POSTED') expect({ order, balance }).toEqual({ order, balance: -100_000n });
      else expect({ order, outcome, balance }).toEqual({ order, outcome: 'INSUFFICIENT_FUNDS', balance: 0n });
    }
  });
});
