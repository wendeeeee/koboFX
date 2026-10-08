import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Clock } from '../../src/common/clock';
import { DomainError, ErrorCode } from '../../src/common/errors';
import { EmailSender } from '../../src/modules/notifications/email/email-sender';
import { FxPoller } from '../../src/modules/fx/fx-poller';
import { FxRateService } from '../../src/modules/fx/fx-rate.service';
import { RECORDED_RATES } from '../../src/mock-exchange-rate-api/mock-exchange-rate-api';
import { WorkerModule } from '../../src/worker.module';
import { CapturingEmailSender, TestClock } from '../support/auth-test-doubles';
import { FxHarness, LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

const POOL_SIZE = 10;

/**
 * FX concurrency (PHASE6_PLAN §F): a warmed pool, contending commands issued back to back,
 * each proven able to fail with scripts/mutation-check.py.
 */
describe('FX concurrency (integration)', () => {
  let harness: LedgerHarness;
  let fx: FxHarness;
  let payments: PaymentsHarness;
  let clock: TestClock;
  let alice: SignedUpUser;

  beforeAll(async () => {
    harness = await startLedgerHarness({ DB_POOL_MAX: String(POOL_SIZE) }, { fx: true });
    fx = harness.fx!;
    payments = harness.payments!;
    clock = harness.auth!.clock;
    alice = await payments.signUp();
  });
  afterAll(() => harness?.close());
  beforeEach(async () => {
    clock.advance(86_400_000);
    alice = await payments.signUp(); // the previous token expired a day ago
    fx.api.clearFaults();
    await fx.resetRedisState();
    await payments.clearRateLimits();
    await fx.warm();
  });

  async function warmPool(): Promise<void> {
    await Promise.all(Array.from({ length: POOL_SIZE }, () => harness.dataSource.query('SELECT pg_sleep(0.2)')));
  }
  const outcome = (promise: Promise<unknown>) =>
    promise.then(
      () => 'CONSUMED',
      (error: unknown) => (error instanceof DomainError ? error.code : `UNEXPECTED ${String(error)}`),
    );

  it('20 parallel consume of one quote: exactly one wins, every other gets QUOTE_ALREADY_USED', async () => {
    const created = await fx.quote(alice, { from: 'NGN', to: 'USD', sourceAmount: '1000000' }).expect(201);
    await warmPool();
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => outcome(fx.quotes.consume(created.body.quoteId, alice.userId))));
    expect(outcomes.filter((result) => result === 'CONSUMED')).toHaveLength(1);
    expect(outcomes.filter((result) => result === ErrorCode.QUOTE_ALREADY_USED)).toHaveLength(19);
  });

  it('consume racing expiry at the boundary: never both consumed and expired, never consumed at or after expiry', async () => {
    for (let round = 0; round < 10; round += 1) {
      const created = await fx.quote(alice, { from: 'NGN', to: 'USD', sourceAmount: '1000000' }).expect(201);
      const expiresAt = Date.parse(created.body.expiresAt);
      clock.advance(expiresAt - clock.now().getTime() - 1); // 1ms before expiry
      await warmPool();
      // Back to back: half the attempts at 1ms before the boundary, half exactly at it.
      const attempts: Promise<string>[] = [];
      for (let index = 0; index < 10; index += 1) {
        attempts.push(outcome(fx.quotes.consume(created.body.quoteId, alice.userId)));
        if (index === round % 10) clock.advance(1);
      }
      const outcomes = await Promise.all(attempts);
      const [row] = (await harness.dataSource.query(`SELECT consumed_at, expires_at FROM quotes WHERE id = $1`, [created.body.quoteId])) as {
        consumed_at: Date | null;
        expires_at: Date;
      }[];
      const winners = outcomes.filter((result) => result === 'CONSUMED').length;
      expect(winners).toBeLessThanOrEqual(1);
      expect(outcomes.every((result) => ['CONSUMED', ErrorCode.QUOTE_ALREADY_USED, ErrorCode.QUOTE_EXPIRED].includes(result))).toBe(true);
      if (winners === 1) expect(row.consumed_at!.getTime()).toBeLessThan(row.expires_at.getTime());
      else expect(row.consumed_at).toBeNull();
      clock.advance(60_000);
      await fx.warm();
    }
  });

  describe('two worker instances polling at once', () => {
    let workers: INestApplicationContext[];

    beforeAll(async () => {
      workers = [];
      for (let index = 0; index < 2; index += 1) {
        const moduleRef = await Test.createTestingModule({ imports: [WorkerModule.forRoot(harness.db.env)] })
          .overrideProvider(Clock)
          .useValue(clock)
          .overrideProvider(EmailSender)
          .useValue(new CapturingEmailSender())
          .compile();
        workers.push(await moduleRef.init());
      }
    });
    afterAll(async () => {
      for (const worker of workers ?? []) await worker.close();
    });

    it('one fetch per publication, no duplicate or interleaved snapshot, the cache never holds a mix of two fetches', async () => {
      const pollers = workers.map((worker) => worker.get(FxPoller));
      const publications: Record<string, string>[] = [];
      for (let round = 0; round < 6; round += 1) {
        clock.advance(400_000); // due
        const publication = { ...RECORDED_RATES, NGN: String(1329 + round), EUR: `0.8${round}5`, GBP: `0.7${round}5` };
        publications.push(publication);
        fx.publishFresh(publication);
        fx.api.failNext({ kind: 'hang', milliseconds: 150 }); // widen the window
        const requests = fx.api.requests;
        const snapshotsBefore = ((await harness.dataSource.query(`SELECT count(*)::int AS n FROM exchange_rate_snapshots`)) as { n: number }[])[0].n;
        // Back to back, several ticks from each worker.
        const results = await Promise.all(Array.from({ length: 6 }, (_, index) => pollers[index % 2].tick()));
        const fetched = results.filter((result) => result.fetched && result.outcome.kind === 'ACCEPTED');
        expect(fetched).toHaveLength(1);
        expect(fx.api.requests - requests).toBe(1);
        const snapshotsAfter = ((await harness.dataSource.query(`SELECT count(*)::int AS n FROM exchange_rate_snapshots`)) as { n: number }[])[0].n;
        expect(snapshotsAfter - snapshotsBefore).toBe(1);
        // Every worker and the API read one whole fetch: exactly this publication's rates.
        for (const reader of [...workers.map((worker) => worker.get(FxRateService)), fx.rates]) {
          reader.forgetLocalCopy();
          const served = await reader.current();
          const rates = Object.fromEntries([...served!.snapshot.rates].map(([code, rate]) => [code, rate.toFixed()]));
          expect(rates).toEqual({ USD: '1', NGN: publication.NGN, EUR: publication.EUR, GBP: publication.GBP });
        }
      }
      expect(publications).toHaveLength(6);
    });
  });
});
