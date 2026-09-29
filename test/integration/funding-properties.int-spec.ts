import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { FlowCheckpoint } from '../../src/modules/flows/flow.types';
import { LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

/**
 * Property-based tests for funding (design §11; handbook: testing). The invariant is
 * the oracle, not a value someone happened to expect:
 *
 * 1. For ANY interleaving of webhook deliveries (duplicated, reordered, stale, dropped,
 *    lying), PSP read lag, resumer ticks and crashes, every flow ends in the state the
 *    PSP's final truth implies, each captured payment is credited EXACTLY once, and the
 *    books are clean after EVERY step.
 * 2. Generative idempotency: every mutating command is replayed a second time, and the
 *    replay has zero additional effect.
 *
 * Generators are steered (whole runs with every webhook dropped, runs with read lag,
 * crash-heavy runs) and the suite asserts at the end that every interesting path ran.
 * No `Math.random` inside an arbitrary: runs are reproducible from the printed seed.
 */

type Token = 'tok_success_prop' | 'tok_decline_insufficient_funds' | 'tok_capture_fail_prop' | 'tok_expire_prop';

type Command =
  | { readonly kind: 'resume'; readonly makeDue: boolean }
  | { readonly kind: 'completeCaptures' }
  | { readonly kind: 'deliver'; readonly event: number; readonly times: number }
  | { readonly kind: 'deliverReversed' }
  | { readonly kind: 'drop'; readonly event: number }
  | { readonly kind: 'lie'; readonly flow: number }
  | { readonly kind: 'process' }
  | { readonly kind: 'crash'; readonly flow: number; readonly point: FlowCheckpoint; readonly mode: 'throw' | 'hang' };

interface Scenario {
  readonly tokens: readonly Token[];
  readonly readLag: number;
  readonly dropAllWebhooks: boolean;
  readonly commands: readonly Command[];
}

const tokenArbitrary: fc.Arbitrary<Token> = fc.oneof(
  { weight: 6, arbitrary: fc.constant<Token>('tok_success_prop') },
  { weight: 1, arbitrary: fc.constant<Token>('tok_decline_insufficient_funds') },
  { weight: 1, arbitrary: fc.constant<Token>('tok_capture_fail_prop') },
  { weight: 1, arbitrary: fc.constant<Token>('tok_expire_prop') },
);

const commandArbitrary: fc.Arbitrary<Command> = fc.oneof(
  { weight: 6, arbitrary: fc.boolean().map((makeDue) => ({ kind: 'resume' as const, makeDue })) },
  { weight: 3, arbitrary: fc.constant({ kind: 'completeCaptures' as const }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('deliver' as const), event: fc.nat(20), times: fc.integer({ min: 1, max: 3 }) }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'deliverReversed' as const }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('drop' as const), event: fc.nat(20) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('lie' as const), flow: fc.nat(3) }) },
  { weight: 4, arbitrary: fc.constant({ kind: 'process' as const }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('crash' as const),
      flow: fc.nat(3),
      point: fc.constantFrom(FlowCheckpoint.AFTER_EXTERNAL_CALL, FlowCheckpoint.BEFORE_COMMIT, FlowCheckpoint.AFTER_COMMIT),
      mode: fc.constantFrom<'throw' | 'hang'>('throw', 'hang'),
    }),
  },
);

const scenarioArbitrary: fc.Arbitrary<Scenario> = fc.record({
  tokens: fc.array(tokenArbitrary, { minLength: 1, maxLength: 3 }),
  // Steered: a third of runs lag the PSP's reads behind its writes.
  readLag: fc.oneof({ weight: 2, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: fc.integer({ min: 1, max: 3 }) }),
  // Steered: a fifth of runs lose every webhook — only the resumer can finish them.
  dropAllWebhooks: fc.oneof({ weight: 4, arbitrary: fc.constant(false) }, { weight: 1, arbitrary: fc.constant(true) }),
  commands: fc.array(commandArbitrary, { minLength: 8, maxLength: 30 }),
});

describe('funding properties (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  const paths = new Map<string, number>();
  const count = (path: string) => paths.set(path, (paths.get(path) ?? 0) + 1);

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { payments: { captureCompletion: 'manual', hangMilliseconds: 400 } });
    payments = harness.payments!;
  });
  afterAll(async () => harness?.close());

  const stateOf = async (flowId: string) =>
    ((await harness.dataSource.query(`SELECT state FROM flow_instances WHERE id = $1`, [flowId])) as { state: string }[])[0].state;
  const paymentIdOf = async (flowId: string) =>
    ((await harness.dataSource.query(`SELECT provider_payment_id FROM funding_payments WHERE flow_id = $1`, [flowId])) as {
      provider_payment_id: string | null;
    }[])[0].provider_payment_id;

  /** Clean books, and no flow credited twice — after every single step. */
  async function assertInvariants(user: SignedUpUser, flowIds: readonly string[]): Promise<void> {
    const report = await harness.checks.runAllChecks();
    expect(report.isClean).toBe(true);
    const postings = (await harness.dataSource.query(
      `SELECT reference, count(*)::int AS n FROM transactions WHERE reference = ANY($1) GROUP BY reference`,
      [flowIds.map((flowId) => `funding:${flowId}`)],
    )) as { reference: string; n: number }[];
    for (const posting of postings) expect(posting.n).toBe(1);
    // Never credit money that has not really been captured: the PSP's truth (not its lagging
    // API, not a webhook) must say captured for every funding we have posted.
    for (const posting of postings) {
      const paymentId = await paymentIdOf(posting.reference.replace('funding:', ''));
      expect({ posting: posting.reference, truth: paymentId ? payments.psp.statusOf(paymentId) : undefined }).toEqual({
        posting: posting.reference,
        truth: 'captured',
      });
    }
    const [balance] = (await harness.dataSource.query(
      `SELECT accounts.balance_minor::text AS balance FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id
        WHERE wallets.user_id = $1 AND accounts.currency_code = 'NGN'`,
      [user.userId],
    )) as { balance: string }[];
    expect(BigInt(balance.balance)).toBe(BigInt(postings.length) * 150_000n);
  }

  async function crash(flowId: string, point: FlowCheckpoint, requestedMode: 'throw' | 'hang'): Promise<void> {
    const mode = point === FlowCheckpoint.BEFORE_COMMIT ? 'throw' : requestedMode;
    const { checkpoints, runner } = payments;
    const state = await stateOf(flowId);
    // A hang inside the transaction would hold its row locks forever; a real crash there
    // closes the connection and rolls back — which is exactly what `throw` models.
    const fired = checkpoints.arm({ state, point, mode });
    const step = runner.advance(flowId, { maxSteps: 1 }).catch(() => undefined);
    const outcome = await Promise.race([fired.then(() => 'fired' as const), step.then(() => 'finished' as const)]);
    checkpoints.disarm();
    if (outcome === 'fired') {
      count('crash');
      if (mode === 'throw') await step;
      await payments.lapseLeases(); // the dead worker's lease runs out
    }
  }

  it('any interleaving of webhook chaos, read lag, resumer ticks and crashes: PSP truth reached, credited exactly once, clean after every step', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async (scenario) => {
        const { psp, resumer, processor } = payments;
        await payments.clearRateLimits();
        psp.setReadLag(scenario.readLag);
        psp.clearFaults();
        for (const event of psp.pendingWebhooks()) psp.drop(event.id);
        const user = await payments.signUp();
        const flowIds: string[] = [];
        for (const token of scenario.tokens) {
          const response = await payments.fund(user, { amount: '150000', currency: 'NGN', paymentMethodToken: token }).expect(202);
          flowIds.push((response.body as { fundingId: string }).fundingId);
        }
        const ours = async () => {
          const ids = await Promise.all(flowIds.map(paymentIdOf));
          return psp.pendingWebhooks().filter((event) => ids.includes(event.paymentId));
        };

        for (const command of scenario.commands) {
          if (scenario.dropAllWebhooks) for (const event of await ours()) psp.drop(event.id);
          switch (command.kind) {
            case 'resume':
              if (command.makeDue) await payments.makeAllDue();
              await resumer.resumeDue(100);
              break;
            case 'completeCaptures':
              for (const flowId of flowIds) {
                const paymentId = await paymentIdOf(flowId);
                if (paymentId && psp.statusOf(paymentId) === 'capture_pending') {
                  psp.completeCapture(paymentId);
                  if (scenario.readLag > 0) count('capture completed under read lag');
                }
              }
              break;
            case 'deliver': {
              const events = await ours();
              if (events.length === 0) break;
              const event = events[command.event % events.length];
              await psp.deliver(event.id, command.times);
              if (command.times > 1) count('duplicate delivery');
              break;
            }
            case 'deliverReversed': {
              const events = await ours();
              if (events.length > 1) count('reordered delivery');
              for (const event of [...events].reverse()) await psp.deliver(event.id);
              break;
            }
            case 'drop': {
              const events = await ours();
              if (events.length > 0) {
                psp.drop(events[command.event % events.length].id);
                count('dropped webhook');
              }
              break;
            }
            case 'lie': {
              const paymentId = await paymentIdOf(flowIds[command.flow % flowIds.length]);
              if (paymentId && !scenario.dropAllWebhooks) {
                psp.emitWebhook(paymentId, 'payment.captured');
                count('lying webhook');
              }
              break;
            }
            case 'process':
              await processor.processDue(100);
              break;
            case 'crash':
              await crash(flowIds[command.flow % flowIds.length], command.point, command.mode);
              break;
          }
          await assertInvariants(user, flowIds);
        }

        // Let the world settle: the PSP finishes pending captures; the worker runs until quiet.
        for (let round = 0; round < 6; round += 1) {
          for (const flowId of flowIds) {
            const paymentId = await paymentIdOf(flowId);
            if (paymentId && psp.statusOf(paymentId) === 'capture_pending') psp.completeCapture(paymentId);
          }
          if (scenario.dropAllWebhooks) for (const event of await ours()) psp.drop(event.id);
          await payments.lapseLeases();
          await payments.drive({ deliverWebhooks: !scenario.dropAllWebhooks });
          await assertInvariants(user, flowIds);
        }

        for (const flowId of flowIds) {
          const paymentId = await paymentIdOf(flowId);
          const truth = paymentId ? psp.statusOf(paymentId) : undefined;
          const expected = truth === 'captured' ? 'POSTED' : 'FAILED';
          expect({ truth, state: await stateOf(flowId) }).toEqual({ truth, state: expected });
          count(expected === 'POSTED' ? 'posted' : `failed after ${truth}`);
          if (expected === 'POSTED' && scenario.dropAllWebhooks) count('webhook never arrived, resumer completed');
        }
        const lagged = (await harness.dataSource.query(
          `SELECT count(*)::int AS n FROM webhook_events WHERE last_error LIKE '%has not confirmed%' OR outcome = 'ADVANCED' AND attempts > 1`,
        )) as { n: number }[];
        if (lagged[0].n > 0) count('webhook ahead of the API, retried');
        const stale = (await harness.dataSource.query(`SELECT count(*)::int AS n FROM webhook_events WHERE outcome = 'NO_CHANGE'`)) as { n: number }[];
        if (stale[0].n > 0) count('stale or duplicate webhook ignored');
      }),
      { numRuns: 30 },
    );

    const required = [
      'posted',
      'failed after declined',
      'failed after capture_failed',
      'failed after expired',
      'crash',
      'duplicate delivery',
      'reordered delivery',
      'dropped webhook',
      'lying webhook',
      'capture completed under read lag',
      'webhook never arrived, resumer completed',
      'webhook ahead of the API, retried',
      'stale or duplicate webhook ignored',
    ];
    expect(Object.fromEntries(required.map((path) => [path, (paths.get(path) ?? 0) > 0]))).toEqual(
      Object.fromEntries(required.map((path) => [path, true])),
    );
  });

  describe('generative idempotency (§11): every mutating command, replayed, has zero additional effect', () => {
    type ApiCommand =
      | { readonly kind: 'fund'; readonly amount: string; readonly token: Token; readonly reuseKey: boolean }
      | { readonly kind: 'deliver'; readonly event: number }
      | { readonly kind: 'process' }
      | { readonly kind: 'tick' };

    const apiCommand: fc.Arbitrary<ApiCommand> = fc.oneof(
      {
        weight: 3,
        arbitrary: fc.record({
          kind: fc.constant('fund' as const),
          // Steered: some amounts below the minimum (a permanent failure must replay too).
          amount: fc.oneof({ weight: 4, arbitrary: fc.constant('150000') }, { weight: 1, arbitrary: fc.constant('50') }),
          token: tokenArbitrary,
          reuseKey: fc.boolean(),
        }),
      },
      { weight: 3, arbitrary: fc.record({ kind: fc.constant('deliver' as const), event: fc.nat(20) }) },
      { weight: 2, arbitrary: fc.constant({ kind: 'process' as const }) },
      { weight: 3, arbitrary: fc.constant({ kind: 'tick' as const }) },
    );

    /** Everything a command could change: money, flows, keys, stored webhooks. */
    async function effect(): Promise<unknown> {
      const snapshot = await harness.snapshot();
      const [flows] = (await harness.dataSource.query(`
        SELECT (SELECT md5(coalesce(string_agg(id::text || ':' || state || ':' || coalesce(completed_at::text, '-'), ',' ORDER BY id), '')) FROM flow_instances) AS flows,
               (SELECT md5(coalesce(string_agg(user_id::text || key || status || coalesce(response_body, '-'), ',' ORDER BY user_id, key), '')) FROM idempotency_keys) AS keys,
               (SELECT count(*)::int FROM webhook_events) AS webhook_events,
               (SELECT count(*)::int FROM funding_payments) AS funding_payments
      `)) as unknown[];
      return { ...snapshot, auditLogCount: undefined, flows };
    }

    it('replaying any fund request, webhook delivery or processor pass changes nothing', async () => {
      const replayed = new Map<string, number>();
      await fc.assert(
        fc.asyncProperty(fc.array(apiCommand, { minLength: 5, maxLength: 15 }), async (commands) => {
          const { psp, processor, resumer } = payments;
          await payments.clearRateLimits();
          psp.setReadLag(0);
          psp.setCaptureCompletion('immediate');
          for (const event of psp.pendingWebhooks()) psp.drop(event.id);
          const user = await payments.signUp();
          let lastKey = randomUUID();

          /** The wrapper: run the command, then run it again and demand zero additional effect. */
          async function twice<T>(name: string, command: () => Promise<T>, same: (first: T, second: T) => void): Promise<void> {
            const first = await command();
            const after = await effect();
            const second = await command();
            expect(await effect()).toEqual(after);
            same(first, second);
            replayed.set(name, (replayed.get(name) ?? 0) + 1);
          }

          for (const command of commands) {
            switch (command.kind) {
              case 'fund': {
                const key = command.reuseKey ? lastKey : randomUUID();
                lastKey = key;
                const request = { amount: command.amount, currency: 'NGN', paymentMethodToken: command.token };
                const call = async () => {
                  const response = await payments.fund(user, request, key);
                  return { status: response.status, code: (response.body as { code?: string }).code, text: response.text };
                };
                await twice(`fund ${command.amount === '50' ? 'refused' : 'accepted'}`, call, (first, second) => {
                  if (first.code === 'IDEMPOTENCY_KEY_REUSE') {
                    // A refusal of THIS request, not a stored outcome: same answer, its own correlation id.
                    expect({ status: second.status, code: second.code }).toEqual({ status: first.status, code: first.code });
                  } else {
                    expect(second.text).toBe(first.text); // stored outcomes replay byte for byte
                  }
                });
                break;
              }
              case 'deliver': {
                const events = psp.pendingWebhooks();
                if (events.length === 0) break;
                const event = events[command.event % events.length];
                const signature = psp.sign(event.body);
                const deliver = async () =>
                  (
                    await (await import('supertest'))
                      .default(harness.auth!.app.getHttpServer())
                      .post('/api/v1/webhooks/psp')
                      .set('Content-Type', 'application/json')
                      .set('X-Psp-Signature', signature)
                      .send(event.body.toString('utf8'))
                  ).status;
                psp.drop(event.id);
                await twice('webhook delivery', deliver, (first, second) => expect(second).toBe(first));
                break;
              }
              case 'process':
                await twice('processor pass', () => processor.processDue(100).then(() => undefined), () => undefined);
                break;
              case 'tick':
                // Progress, not a command: time passes and the resumer runs (not replayed).
                await payments.makeAllDue();
                await resumer.resumeDue(100);
                break;
            }
          }
          await harness.expectCleanBooks();
        }),
        { numRuns: 15 },
      );
      expect([...replayed.keys()].sort()).toEqual(['fund accepted', 'fund refused', 'processor pass', 'webhook delivery']);
    });
  });
});
