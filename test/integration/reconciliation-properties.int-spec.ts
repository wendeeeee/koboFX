import fc from 'fast-check';
import { BreakType } from '../../src/modules/reconciliation/break-types';
import { BreakStatus } from '../../src/modules/reconciliation/break-transitions';
import { ReconciliationRunKind } from '../../src/modules/reconciliation/reconciliation-schedule';
import { LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';
import { expectedSettlementDeadline } from '../support/settlement-window-oracle';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const PROVIDER = 'simulated-psp';
const payment = (id: string) => `payment:${PROVIDER}:${id}`;

/** The model's view of one deposit — independent of the code under test. */
interface ModelDeposit {
  readonly flowId: string;
  readonly paymentId: string;
  readonly amountMinor: bigint;
  readonly capturedAt: Date;
  /** Paid out in a batch the PSP made (whether or not we have read it yet). */
  paidOutInBatch: string | null;
  /** That batch is visible and a run has read it. */
  settledInBooks: boolean;
  reversed: boolean;
  forgotten: boolean;
  /** A mismatch break owns it: it is never ALSO late. */
  owned: boolean;
}

interface ModelBatch {
  readonly batchId: string;
  readonly visibleFrom: number;
  readonly paymentIds: readonly string[];
  /** Every line attributed (safe to re-issue as a pure duplicate). */
  readonly clean: boolean;
  read: boolean;
}

/** `type|subject` → must be resolved (true) or live (false). */
type Expected = Map<string, boolean>;

type Command =
  | { readonly kind: 'fund'; readonly amount: bigint }
  | { readonly kind: 'decline' }
  | { readonly kind: 'chargeback-before'; readonly pick: number }
  | { readonly kind: 'chargeback-after'; readonly pick: number }
  | { readonly kind: 'settle'; readonly mode: 'all' | 'partial' | 'late'; readonly pick: number }
  | { readonly kind: 'fault-amount'; readonly pick: number }
  | { readonly kind: 'fault-unknown' }
  | { readonly kind: 'fault-foreign' }
  | { readonly kind: 'fault-forget'; readonly pick: number }
  | { readonly kind: 'fault-reissue' }
  | { readonly kind: 'advance'; readonly hours: number }
  | { readonly kind: 'run' };

const PATHS = [
  'fund',
  'decline',
  'chargeback-before',
  'chargeback-after',
  'settle-all',
  'settle-partial',
  'settle-late',
  'fault-amount',
  'fault-unknown',
  'fault-foreign',
  'fault-forget',
  'fault-reissue',
  'unsettled-detected',
  'unsettled-resolved',
] as const;
type Path = (typeof PATHS)[number];

/** Walks every path, whatever the generated tail does. */
const PRELUDE: readonly Command[] = [
  { kind: 'fund', amount: 150_000n },
  { kind: 'fund', amount: 260_000n },
  { kind: 'fund', amount: 370_000n },
  { kind: 'fund', amount: 480_000n },
  { kind: 'fund', amount: 590_000n },
  { kind: 'decline' },
  { kind: 'chargeback-before', pick: 0 },
  { kind: 'settle', mode: 'partial', pick: 0 },
  { kind: 'run' },
  { kind: 'fault-reissue' },
  { kind: 'chargeback-after', pick: 0 },
  { kind: 'fault-amount', pick: 0 },
  { kind: 'fault-forget', pick: 0 },
  { kind: 'fault-unknown' },
  { kind: 'fault-foreign' },
  { kind: 'advance', hours: 5 * 24 },
  { kind: 'run' },
  // A deposit paid out in a batch published late: past its window (6 days clears even a Friday
  // capture's T+2 deadline) it is UNSETTLED_PAST_WINDOW; once the batch appears, SETTLED_LATE.
  { kind: 'fund', amount: 610_000n },
  { kind: 'settle', mode: 'late', pick: 0 },
  { kind: 'advance', hours: 6 * 24 },
  { kind: 'run' },
  { kind: 'advance', hours: 5 * 24 },
  { kind: 'run' },
  { kind: 'settle', mode: 'all', pick: 0 },
  { kind: 'run' },
];

const command: fc.Arbitrary<Command> = fc.oneof(
  { weight: 5, arbitrary: fc.bigInt({ min: 100n, max: 2_000_000n }).map((amount) => ({ kind: 'fund' as const, amount })) },
  { weight: 1, arbitrary: fc.constant({ kind: 'decline' as const }) },
  { weight: 1, arbitrary: fc.nat().map((pick) => ({ kind: 'chargeback-before' as const, pick })) },
  { weight: 1, arbitrary: fc.nat().map((pick) => ({ kind: 'chargeback-after' as const, pick })) },
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant('settle' as const), mode: fc.constantFrom('all' as const, 'partial' as const, 'late' as const), pick: fc.nat() }),
  },
  { weight: 1, arbitrary: fc.nat().map((pick) => ({ kind: 'fault-amount' as const, pick })) },
  { weight: 1, arbitrary: fc.constant({ kind: 'fault-unknown' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'fault-foreign' as const }) },
  { weight: 1, arbitrary: fc.nat().map((pick) => ({ kind: 'fault-forget' as const, pick })) },
  { weight: 1, arbitrary: fc.constant({ kind: 'fault-reissue' as const }) },
  // ≤ 48h a step: a forgotten deposit is always re-checked inside the 35-day lookback.
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 48 }).map((hours) => ({ kind: 'advance' as const, hours })) },
  { weight: 4, arbitrary: fc.constant({ kind: 'run' as const }) },
);

/**
 * Reconciliation, for ANY steered sequence of fundings, declines, chargebacks (before and after
 * settlement), settlement batches (on time, partial, late), injected PSP faults and clock moves:
 *
 * - after EVERY step the books are clean;
 * - after every run the breaks in the database are EXACTLY what an independent model expects —
 *   type, subject, and whether resolved — no false positives, no false negatives;
 * - with no faults injected, there are no breaks at all.
 */
describe('reconciliation properties (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let user: SignedUpUser;
  const deposits: ModelDeposit[] = [];
  const batches: ModelBatch[] = [];
  const expected: Expected = new Map();

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { payments: true });
    payments = harness.payments!;
    harness.auth!.clock.freeze();
    user = await payments.signUp();
  });
  afterAll(async () => harness?.close());

  const clock = () => harness.auth!.clock;
  const now = () => clock().now();
  const expect_ = (type: BreakType, subject: string, resolved: boolean) => expected.set(`${type}|${subject}`, resolved);

  async function fundOne(amount: bigint, token = 'tok_success_visa'): Promise<string> {
    let response = await payments.fund(user, { amount: amount.toString(), currency: 'NGN', paymentMethodToken: token });
    if (response.status === 401) {
      await payments.clearRateLimits();
      user = await payments.logIn(user);
      response = await payments.fund(user, { amount: amount.toString(), currency: 'NGN', paymentMethodToken: token });
    }
    expect(response.status).toBe(202);
    await payments.drive();
    return response.body.fundingId as string;
  }

  const pickFrom = <T>(pool: T[], pick: number): T | undefined => (pool.length === 0 ? undefined : pool[pick % pool.length]);
  const settleable = () => deposits.filter((deposit) => !deposit.paidOutInBatch && !deposit.forgotten);

  /** Replays what one daily run will conclude, then checks the database says exactly that. */
  async function runAndCheck(ran: Set<Path>): Promise<void> {
    const at = now().getTime();
    for (const batch of batches) {
      if (!batch.read && batch.visibleFrom <= at) {
        batch.read = true;
        for (const deposit of deposits) if (deposit.paidOutInBatch === batch.batchId && !deposit.owned) deposit.settledInBooks = true;
      }
    }
    for (const deposit of deposits) {
      const key = `${BreakType.UNSETTLED_PAST_WINDOW}|${payment(deposit.paymentId)}`;
      const late = !deposit.settledInBooks && !deposit.reversed && !deposit.owned && at > expectedSettlementDeadline(deposit.capturedAt, 2, 24).getTime();
      if (late && !expected.has(key)) {
        expected.set(key, false);
        ran.add('unsettled-detected');
      }
      if (expected.get(key) === false && (deposit.settledInBooks || deposit.reversed)) {
        expected.set(key, true);
        ran.add('unsettled-resolved');
      }
    }
    await payments.reconciliation.run(ReconciliationRunKind.EXTERNAL_DAILY);
    const actual = (await harness.dataSource.query(`SELECT type::text AS type, subject_key, status::text AS status FROM reconciliation_breaks`)) as {
      type: string;
      subject_key: string;
      status: string;
    }[];
    const actualMap = new Map(actual.map((row) => [`${row.type}|${row.subject_key}`, row.status === BreakStatus.RESOLVED]));
    expect(Object.fromEntries([...actualMap.entries()].sort())).toEqual(Object.fromEntries([...expected.entries()].sort()));
    expect(actual.length).toBe(actualMap.size); // never two breaks for one subject
  }

  async function step(commandToRun: Command, ran: Set<Path>): Promise<void> {
    const { psp } = payments;
    switch (commandToRun.kind) {
      case 'fund': {
        const flowId = await fundOne(commandToRun.amount);
        const [row] = (await harness.dataSource.query(`SELECT provider_payment_id, captured_at FROM funding_payments WHERE flow_id = $1`, [flowId])) as {
          provider_payment_id: string;
          captured_at: Date;
        }[];
        deposits.push({
          flowId,
          paymentId: row.provider_payment_id,
          amountMinor: commandToRun.amount,
          capturedAt: row.captured_at,
          paidOutInBatch: null,
          settledInBooks: false,
          reversed: false,
          forgotten: false,
          owned: false,
        });
        ran.add('fund');
        return;
      }
      case 'decline':
        await fundOne(5_000n, 'tok_decline_insufficient_funds');
        ran.add('decline');
        return;
      case 'chargeback-before': {
        const target = pickFrom(settleable().filter((deposit) => !deposit.reversed && !deposit.owned), commandToRun.pick);
        if (!target) return;
        psp.chargeback(target.paymentId);
        await payments.drive(); // the webhook is delivered: reversed at once
        target.reversed = true;
        ran.add('chargeback-before');
        return;
      }
      case 'chargeback-after': {
        const target = pickFrom(
          deposits.filter((deposit) => deposit.paidOutInBatch && !deposit.reversed && !deposit.owned && !deposit.forgotten),
          commandToRun.pick,
        );
        if (!target) return;
        psp.chargeback(target.paymentId);
        for (const event of psp.pendingWebhooks()) psp.drop(event.id); // lost
        clock().advance(2 * HOUR); // old enough for the completeness check
        // The next run finds it, and reverses it through the flow: detected and resolved.
        expect_(BreakType.CHARGEBACK_NOT_REVERSED, `flow:${target.flowId}`, true);
        target.reversed = true;
        ran.add('chargeback-after');
        return;
      }
      case 'settle': {
        const pool = settleable();
        const chosen =
          commandToRun.mode === 'partial' ? pool.filter((_deposit, index) => index % 2 === commandToRun.pick % 2) : pool;
        if (commandToRun.mode === 'partial' && chosen.length === pool.length && pool.length > 0) chosen.pop();
        const visibleFrom = commandToRun.mode === 'late' ? new Date(now().getTime() + 10 * DAY) : now();
        const batchId = psp.settle({ currency: 'NGN', paymentIds: chosen.map((deposit) => deposit.paymentId), visibleFrom });
        for (const deposit of chosen) deposit.paidOutInBatch = batchId;
        batches.push({ batchId, visibleFrom: visibleFrom.getTime(), paymentIds: chosen.map((deposit) => deposit.paymentId), clean: true, read: false });
        ran.add(`settle-${commandToRun.mode}`);
        return;
      }
      case 'fault-amount': {
        const target = pickFrom(settleable().filter((deposit) => !deposit.reversed), commandToRun.pick);
        if (!target) return;
        const batchId = psp.settle({ currency: 'NGN', paymentIds: [target.paymentId], alterAmounts: { [target.paymentId]: -1n }, deductChargebacks: false });
        target.paidOutInBatch = batchId;
        target.owned = true;
        batches.push({ batchId, visibleFrom: now().getTime(), paymentIds: [target.paymentId], clean: false, read: false });
        expect_(BreakType.AMOUNT_MISMATCH, payment(target.paymentId), false);
        ran.add('fault-amount');
        return;
      }
      case 'fault-unknown': {
        const batchId = psp.settle({ currency: 'NGN', paymentIds: [], unknownLines: 1, deductChargebacks: false });
        batches.push({ batchId, visibleFrom: now().getTime(), paymentIds: [], clean: false, read: false });
        expect_(BreakType.UNATTRIBUTED_SETTLEMENT_LINE, `line:${PROVIDER}:${batchId}:${batchId}_l0001`, false);
        ran.add('fault-unknown');
        return;
      }
      case 'fault-foreign': {
        const foreign = psp.createForeignPayment('33000', 'NGN');
        // Paid out (to CLEARING) the next time a batch pays everything; seen by the completeness
        // check once old enough — the same one break either way.
        clock().advance(2 * HOUR);
        const batchId = psp.settle({ currency: 'NGN', paymentIds: [foreign], deductChargebacks: false });
        batches.push({ batchId, visibleFrom: now().getTime(), paymentIds: [foreign], clean: false, read: false });
        expect_(BreakType.PAYMENT_WITHOUT_FLOW, payment(foreign), false);
        ran.add('fault-foreign');
        return;
      }
      case 'fault-forget': {
        const target = pickFrom(
          settleable().filter((deposit) => !deposit.reversed && now().getTime() - deposit.capturedAt.getTime() < 5 * DAY),
          commandToRun.pick,
        );
        if (!target) return;
        psp.forget(target.paymentId);
        target.forgotten = true;
        target.owned = true;
        expect_(BreakType.MISSING_AT_PSP, payment(target.paymentId), false);
        ran.add('fault-forget');
        return;
      }
      case 'fault-reissue': {
        const original = [...batches].reverse().find((batch) => batch.clean && batch.read && batch.paymentIds.length > 0);
        if (!original) return;
        const copy = psp.reissue(original.batchId);
        const report = psp.report(copy) as { lines: { data: { id: string; type: string }[] } };
        batches.push({ batchId: copy, visibleFrom: now().getTime(), paymentIds: [], clean: false, read: false });
        for (const line of report.lines.data) expect_(BreakType.DUPLICATE_SETTLEMENT_LINE, `line:${PROVIDER}:${copy}:${line.id}`, false);
        ran.add('fault-reissue');
        return;
      }
      case 'advance':
        clock().advance(commandToRun.hours * HOUR);
        return;
      case 'run':
        await runAndCheck(ran);
        return;
    }
  }

  it('after every step the books are clean, and every run reports exactly the injected discrepancies (every path runs)', async () => {
    const coverage = new Map<Path, number>(PATHS.map((path) => [path, 0]));
    await fc.assert(
      fc.asyncProperty(fc.array(command, { minLength: 4, maxLength: 14 }), async (tail) => {
        const ran = new Set<Path>();
        // Every run ends settled and read, so the next run (and the no-fault property) starts quiet.
        const finale: Command[] = [{ kind: 'settle', mode: 'all', pick: 0 }, { kind: 'advance', hours: 7 * 24 }, { kind: 'run' }];
        for (const [index, next] of [...PRELUDE, ...tail, ...finale].entries()) {
          if (index === PRELUDE.length) {
            // The prelude walked every path in THIS run.
            expect(PATHS.filter((path) => !ran.has(path))).toEqual([]);
          }
          await step(next, ran);
          await harness.expectCleanBooks();
        }
        for (const path of ran) coverage.set(path, (coverage.get(path) ?? 0) + 1);
      }),
      { numRuns: 4, interruptAfterTimeLimit: 600_000, markInterruptAsFailure: true, endOnFailure: true },
    );
    console.info('reconciliation property paths', Object.fromEntries(coverage));
  }, 900_000);

  it('with no faults injected — on-time batches, any clock moves inside the window — there are no breaks at all', async () => {
    const [{ before }] = (await harness.dataSource.query(`SELECT count(*)::int AS before FROM reconciliation_breaks`)) as { before: number }[];
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ fundings: fc.integer({ min: 1, max: 3 }), hoursBefore: fc.integer({ min: 0, max: 30 }), hoursAfter: fc.integer({ min: 0, max: 12 }) }), {
          minLength: 2,
          maxLength: 5,
        }),
        async (rounds) => {
          for (const round of rounds) {
            const fresh: string[] = [];
            for (let index = 0; index < round.fundings; index += 1) {
              const flowId = await fundOne(BigInt(1_000 + index * 7));
              fresh.push(((await harness.dataSource.query(`SELECT provider_payment_id FROM funding_payments WHERE flow_id = $1`, [flowId])) as { provider_payment_id: string }[])[0].provider_payment_id);
            }
            clock().advance(round.hoursBefore * HOUR);
            payments.psp.settle({ currency: 'NGN', paymentIds: fresh, deductChargebacks: false });
            clock().advance(round.hoursAfter * HOUR);
            const result = await payments.reconciliation.run(ReconciliationRunKind.EXTERNAL_DAILY);
            const created = (await harness.dataSource.query(`SELECT type::text AS type, subject_key FROM reconciliation_breaks WHERE detected_by_run_id = $1`, [
              result.runId,
            ])) as unknown[];
            expect(created).toEqual([]);
            await harness.expectCleanBooks();
          }
        },
      ),
      { numRuns: 3, interruptAfterTimeLimit: 300_000, markInterruptAsFailure: true },
    );
    const [{ after }] = (await harness.dataSource.query(`SELECT count(*)::int AS after FROM reconciliation_breaks`)) as { after: number }[];
    expect(after).toBe(before);
  }, 600_000);
});
