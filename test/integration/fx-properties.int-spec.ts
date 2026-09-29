import { randomUUID } from 'node:crypto';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import fc from 'fast-check';
import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { Clock } from '../../src/common/clock';
import { MockFault, RECORDED_RATES } from '../../src/mock-exchange-rate-api/mock-exchange-rate-api';
import { RateTier, freshnessOf } from '../../src/modules/fx/freshness';
import { FxPoller } from '../../src/modules/fx/fx-poller';
import { EmailSender } from '../../src/modules/notifications/email/email-sender';
import { WorkerModule } from '../../src/worker.module';
import { CapturingEmailSender, TestClock } from '../support/auth-test-doubles';
import { FxHarness, LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

const DAILY_BUDGET = 8;
const MONTHLY_BUDGET = 40;
const EXECUTABLE_SECONDS = 420;
const DISPLAY_SECONDS = 900;
const GRACE_SECONDS = 120;

type Action =
  | { readonly kind: 'publish'; readonly variant: 'good' | 'stale' | 'missing-currency' | 'jump' }
  | { readonly kind: 'fault'; readonly fault: MockFault; readonly times: number }
  | { readonly kind: 'advance'; readonly seconds: number }
  | { readonly kind: 'tick'; readonly pollers: 'first' | 'second' | 'both' }
  | { readonly kind: 'burst'; readonly reads: number; readonly quotes: number };

/** Steered: every path must be reachable within a run of 20–40 steps. */
const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('publish' as const), variant: fc.constantFrom('good' as const, 'good' as const, 'stale' as const, 'missing-currency' as const, 'jump' as const) }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('fault' as const),
      fault: fc.oneof(
        fc.constant<MockFault>({ kind: 'server-error' }),
        fc.constant<MockFault>({ kind: 'garbage' }),
        fc.constant<MockFault>({ kind: 'rate-limited' }),
        fc.constant<MockFault>({ kind: 'hang', milliseconds: 600 }),
        fc.record({
          kind: fc.constant('error-type' as const),
          errorType: fc.constantFrom('quota-reached', 'invalid-key', 'inactive-account', 'unsupported-code', 'malformed-request'),
          status: fc.constantFrom(200, 403),
        }),
      ),
      times: fc.integer({ min: 1, max: 4 }),
    }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('advance' as const), seconds: fc.constantFrom(1, 59, 61, 119, 121, 300, 361, 419, 421, 899, 901, 3_600, 86_400) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('tick' as const), pollers: fc.constantFrom('first' as const, 'second' as const, 'both' as const) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('burst' as const), reads: fc.integer({ min: 0, max: 4 }), quotes: fc.integer({ min: 0, max: 3 }) }) },
);

/**
 * The FX pipeline as a whole (PHASE6_PLAN §F): for any sequence of provider behaviours,
 * request bursts and clock advances — with two worker instances polling — after EVERY step:
 * provider calls never exceed the budget; no executable rate older than the executable
 * window; nothing older than the display window; never a rate that failed a sanity check;
 * and GET /fx/rates always states its true age.
 */
describe('FX pipeline properties (integration)', () => {
  let harness: LedgerHarness;
  let fx: FxHarness;
  let payments: PaymentsHarness;
  let clock: TestClock;
  let user: SignedUpUser;
  let secondWorker: INestApplicationContext;

  beforeAll(async () => {
    harness = await startLedgerHarness(
      { FX_DAILY_REQUEST_BUDGET: String(DAILY_BUDGET), FX_MONTHLY_REQUEST_BUDGET: String(MONTHLY_BUDGET), FX_READ_RETRIES: '1' },
      { fx: true },
    );
    fx = harness.fx!;
    payments = harness.payments!;
    clock = harness.auth!.clock;
    user = await payments.signUp();
    // The first-ever fetch has no history and is judged on bounds only: establish the normal
    // baseline first, as production's first fetch does (a generated "jump" as the very first
    // publication would otherwise become the baseline, and every normal rate a > 20% move).
    await fx.warm();
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule.forRoot(harness.db.env)] })
      .overrideProvider(Clock)
      .useValue(clock)
      .overrideProvider(EmailSender)
      .useValue(new CapturingEmailSender())
      .compile();
    secondWorker = await moduleRef.init();
  });
  afterAll(async () => {
    await secondWorker?.close();
    await harness?.close();
  });

  const http = () => request(harness.auth!.app.getHttpServer());
  const snapshotRow = async (id: string) =>
    ((await harness.dataSource.query(
      `SELECT status, provider_updated_at, provider_next_update_at FROM exchange_rate_snapshots WHERE id = $1`,
      [id],
    )) as { status: string; provider_updated_at: Date; provider_next_update_at: Date }[])[0];

  it('invariants hold after every step of any generated sequence (and every path runs)', async () => {
    const seen = new Map<string, number>();
    const see = (path: string) => seen.set(path, (seen.get(path) ?? 0) + 1);
    const policy = { executableMaximumAgeSeconds: EXECUTABLE_SECONDS, displayMaximumAgeSeconds: DISPLAY_SECONDS, publicationGraceSeconds: GRACE_SECONDS };

    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 20, maxLength: 40 }), async (actions) => {
        // A fresh month and a clean slate for every run: budgets are per UTC month/day on the clock.
        clock.advance(40 * 86_400_000);
        user = await payments.signUp();
        let signedUpAt = clock.now().getTime();
        fx.api.clearFaults();
        await fx.resetRedisState();
        const requestsByDay = new Map<string, number>();
        const requestsByMonth = new Map<string, number>();
        let lastRates: Record<string, string> = { ...RECORDED_RATES };

        // A fixed prelude that walks EVERY required path, so each runs in every run: 12 unseeded runs
        // missed a different one in three Phase 8 full runs ('rates-fresh', 'REJECTED',
        // 'FAILED:TRANSIENT'). ~5 provider calls of the daily 8. The generated tail keeps exploring.
        const prelude: Action[] = [
          { kind: 'publish', variant: 'good' },
          { kind: 'tick', pollers: 'first' }, // ACCEPTED
          { kind: 'burst', reads: 1, quotes: 1 }, // rates-fresh, quote-201
          { kind: 'tick', pollers: 'first' }, // not-due (just fetched)
          { kind: 'fault', fault: { kind: 'server-error' }, times: 2 },
          { kind: 'advance', seconds: 421 }, // past the next publication + jitter; the rate is now display-only
          { kind: 'tick', pollers: 'first' }, // FAILED:TRANSIENT (breaker 60s)
          { kind: 'tick', pollers: 'first' }, // SKIPPED:BACKING_OFF
          { kind: 'burst', reads: 1, quotes: 1 }, // rates-stale, quote-FX_RATE_STALE
          { kind: 'publish', variant: 'jump' },
          { kind: 'advance', seconds: 61 }, // the breaker lapses
          { kind: 'tick', pollers: 'first' }, // REJECTED
          { kind: 'advance', seconds: 900 }, // nothing displayable any more
          { kind: 'burst', reads: 1, quotes: 0 }, // rates-503
        ];
        const preludePaths = ['ACCEPTED', 'REJECTED', 'FAILED:TRANSIENT', 'not-due', 'SKIPPED:BACKING_OFF', 'rates-fresh', 'rates-stale', 'rates-503', 'quote-201', 'quote-FX_RATE_STALE'];
        const before = new Map(preludePaths.map((path) => [path, seen.get(path) ?? 0]));
        for (const [index, step] of [...prelude, ...actions].entries()) {
          // The prelude's promise, checked: by its end this run has walked every required path.
          if (index === prelude.length) {
            expect({ unwalked: preludePaths.filter((path) => (seen.get(path) ?? 0) === before.get(path)) }).toEqual({ unwalked: [] });
          }
          const day = clock.now().toISOString().slice(0, 10);
          const month = day.slice(0, 7);
          const requestsBefore = fx.api.requests;
          switch (step.kind) {
            case 'publish': {
              const rates = { ...lastRates };
              if (step.variant === 'missing-currency') delete rates.GBP;
              if (step.variant === 'jump') rates.NGN = String(Number.parseFloat(lastRates.NGN) * 1.5);
              if (step.variant === 'stale') fx.publishFresh(rates, { publishedSecondsAgo: 600, nextUpdateInSeconds: -300 });
              else fx.publishFresh(rates);
              if (step.variant === 'good') lastRates = rates;
              break;
            }
            case 'fault':
              fx.api.failNext(...Array.from({ length: step.times }, () => step.fault));
              break;
            case 'advance':
              clock.advance(step.seconds * 1000);
              break;
            case 'tick': {
              const pollers = [fx.poller, secondWorker.get(FxPoller)];
              const chosen = step.pollers === 'both' ? pollers : [pollers[step.pollers === 'first' ? 0 : 1]];
              const results = await Promise.all(chosen.map((poller) => poller.tick()));
              for (const result of results) {
                if (!result.fetched) see('not-due');
                else see(result.outcome.kind === 'FAILED' ? `FAILED:${result.outcome.failure}` : result.outcome.kind === 'SKIPPED' ? `SKIPPED:${result.outcome.reason}` : result.outcome.kind);
              }
              break;
            }
            case 'burst': {
              await payments.clearRateLimits();
              // Access tokens live 15 minutes on the clock: re-authenticate after long advances.
              if (clock.now().getTime() - signedUpAt > 600_000) {
                user = await payments.signUp();
                signedUpAt = clock.now().getTime();
              }
              const reads = await Promise.all(
                Array.from({ length: step.reads }, () => http().get(`/${API_PREFIX}/fx/rates`).set('Authorization', `Bearer ${user.accessToken}`)),
              );
              const quotes = await Promise.all(
                Array.from({ length: step.quotes }, () => fx.quote(user, { from: 'NGN', to: 'USD', sourceAmount: '1000000' }, randomUUID())),
              );
              const now = clock.now();
              for (const response of reads) {
                if (response.status === 503) {
                  expect(response.body.code).toBe('FX_RATE_UNAVAILABLE');
                  see('rates-503');
                  continue;
                }
                expect(response.status).toBe(200);
                const row = await snapshotRow(response.body.snapshotId);
                // Never a rate that failed a sanity check.
                expect(row.status).toBe('ACCEPTED');
                // Always its true age; never older than the display window.
                expect(response.body.asOf).toBe(row.provider_updated_at.toISOString());
                expect(response.body.rateAgeSeconds).toBe(Math.ceil(Math.max(0, now.getTime() - row.provider_updated_at.getTime()) / 1000));
                expect(response.body.rateAgeSeconds).toBeLessThanOrEqual(DISPLAY_SECONDS);
                const freshness = freshnessOf({ providerUpdatedAt: row.provider_updated_at, providerNextUpdateAt: row.provider_next_update_at }, now, policy);
                expect(response.body.stale).toBe(freshness.tier !== RateTier.EXECUTABLE);
                see(response.body.stale ? 'rates-stale' : 'rates-fresh');
              }
              for (const response of quotes) {
                if (response.status === 503) {
                  expect(['FX_RATE_STALE', 'FX_RATE_UNAVAILABLE']).toContain(response.body.code);
                  see(`quote-${response.body.code}`);
                  continue;
                }
                expect(response.status).toBe(201);
                const row = await snapshotRow(response.body.rate.snapshotId);
                expect(row.status).toBe('ACCEPTED');
                // Never executed against a rate outside the executable window.
                const issuedAt = new Date(response.body.issuedAt);
                expect(freshnessOf({ providerUpdatedAt: row.provider_updated_at, providerNextUpdateAt: row.provider_next_update_at }, issuedAt, policy).tier).toBe(RateTier.EXECUTABLE);
                see('quote-201');
              }
              break;
            }
          }
          // Provider calls never exceed the budget — counted by the provider itself.
          const made = fx.api.requests - requestsBefore;
          requestsByDay.set(day, (requestsByDay.get(day) ?? 0) + made);
          requestsByMonth.set(month, (requestsByMonth.get(month) ?? 0) + made);
          expect(requestsByDay.get(day)!).toBeLessThanOrEqual(DAILY_BUDGET);
          expect(requestsByMonth.get(month)!).toBeLessThanOrEqual(MONTHLY_BUDGET);
        }
      }),
      { numRuns: 12 },
    );

    // Every interesting path ran at least once across the runs.
    const required = ['ACCEPTED', 'REJECTED', 'FAILED:TRANSIENT', 'not-due', 'SKIPPED:BACKING_OFF', 'rates-fresh', 'rates-stale', 'rates-503', 'quote-201', 'quote-FX_RATE_STALE'];
    expect({ missing: required.filter((path) => !seen.has(path)), seen: Object.fromEntries(seen) }).toEqual({ missing: [], seen: expect.anything() });
  });

  it('the budget binds: with the breaker cleared every time, exactly the daily budget reaches the provider', async () => {
    clock.advance(40 * 86_400_000);
    // Start at 01:00 UTC so the whole test stays inside one budget day.
    const now = clock.now().getTime();
    clock.advance(86_400_000 - (now % 86_400_000) + 3_600_000);
    fx.api.clearFaults();
    await fx.resetRedisState();
    const requests = fx.api.requests;
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await fx.coordination.recordSuccess(); // close the breaker: only the budget stands in the way
      fx.api.failNext({ kind: 'server-error' }, { kind: 'server-error' });
      clock.advance(61_000);
      const outcome = await fx.fetcher.fetch('POLL');
      outcomes.push(outcome.kind === 'FAILED' ? outcome.failure : outcome.kind);
    }
    // FX_READ_RETRIES=1: two attempts per fetch; the fifth fetch finds the day's 8 spent before sending.
    expect(fx.api.requests - requests).toBe(DAILY_BUDGET);
    expect(outcomes).toEqual(['TRANSIENT', 'TRANSIENT', 'TRANSIENT', 'TRANSIENT', 'BUDGET_SPENT', 'BUDGET_SPENT', 'BUDGET_SPENT', 'BUDGET_SPENT']);
    expect(await fx.coordination.usage()).toMatchObject({ dayUsed: DAILY_BUDGET, dailyBudget: DAILY_BUDGET });
    fx.api.clearFaults();
  });

  it('generative idempotency: every POST /fx/quotes replayed has zero additional effect', async () => {
    clock.advance(40 * 86_400_000);
    user = await payments.signUp();
    fx.api.clearFaults(); // faults a random run left queued
    await fx.resetRedisState();
    await fx.warm();
    const pairs = [
      ['NGN', 'USD'],
      ['USD', 'NGN'],
      ['EUR', 'NGN'],
      ['GBP', 'EUR'],
    ] as const;
    const quoteCount = async () => ((await harness.dataSource.query(`SELECT count(*)::int AS n FROM quotes`)) as { n: number }[])[0].n;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...pairs),
        fc.boolean(),
        fc.bigInt({ min: 1n, max: 10n ** 10n }),
        async ([from, to], bySource, amount) => {
          await payments.clearRateLimits();
          const body = bySource ? { from, to, sourceAmount: amount.toString() } : { from, to, targetAmount: amount.toString() };
          const key = randomUUID();
          const first = await fx.quote(user, body, key);
          const count = await quoteCount();
          const replay = await fx.quote(user, body, key);
          expect(replay.status).toBe(first.status);
          expect(replay.text).toBe(first.text);
          expect(await quoteCount()).toBe(count);
          if (first.status < 500) expect(replay.headers['idempotent-replayed']).toBe('true');
        },
      ),
      { numRuns: 40 },
    );
  });
});
