import { FlowCheckpoint } from '../../src/modules/flows/flow.types';
import { FundingState, fundingTransitions } from '../../src/modules/flows/funding/funding-transitions';
import { CrashPlan } from '../support/flow-test-doubles';
import { LedgerHarness, PaymentsHarness, startLedgerHarness } from '../support/ledger-harness';

/**
 * Crash and resume injection (design §11; handbook: "assume every flow dies between any
 * two steps"). For EVERY transition of the funding table the flow executes, and for
 * every boundary of the step that makes it —
 *
 *   after the external call, before the commit    (abort, and kill)
 *   inside the transaction, just before commit    (abort: the transaction rolls back)
 *   after the commit, before the next step        (abort, and kill)
 *
 * — crash once, "restart" (a killed worker's lease lapses), let the resumer (and, for a
 * chargeback, the webhook processor) run, and assert the flow completed EXACTLY once:
 * one posting, one PSP authorization, at most one capture, the right balance, clean books.
 */

interface Scenario {
  readonly from: FundingState;
  readonly to: FundingState;
  readonly token: string;
  /** Capture pending until completed by hand: the crash hits the capture-requested progress commit. */
  readonly manualCapture?: boolean;
  readonly chargeback?: boolean;
  readonly final: FundingState;
  readonly captures: number;
}

const SCENARIOS: readonly Scenario[] = [
  { from: FundingState.INITIATED, to: FundingState.AUTHORIZED, token: 'tok_success_crash', final: FundingState.POSTED, captures: 1 },
  { from: FundingState.INITIATED, to: FundingState.FAILED, token: 'tok_decline_do_not_honor', final: FundingState.FAILED, captures: 0 },
  { from: FundingState.AUTHORIZED, to: FundingState.CAPTURED, token: 'tok_success_crash', final: FundingState.POSTED, captures: 1 },
  { from: FundingState.AUTHORIZED, to: FundingState.AUTHORIZED, token: 'tok_success_crash', manualCapture: true, final: FundingState.POSTED, captures: 1 },
  { from: FundingState.AUTHORIZED, to: FundingState.FAILED, token: 'tok_capture_fail_crash', final: FundingState.FAILED, captures: 0 },
  { from: FundingState.CAPTURED, to: FundingState.POSTED, token: 'tok_success_crash', final: FundingState.POSTED, captures: 1 },
  { from: FundingState.POSTED, to: FundingState.REVERSED, token: 'tok_success_crash', chargeback: true, final: FundingState.REVERSED, captures: 1 },
];

/** Transitions Phase 5 has no step for (settlement is Phase 9). */
const NOT_EXECUTED_IN_PHASE_5 = ['POSTED→SETTLED', 'SETTLED→REVERSED'];

const BOUNDARIES: readonly Pick<CrashPlan, 'point' | 'mode'>[] = [
  { point: FlowCheckpoint.AFTER_EXTERNAL_CALL, mode: 'throw' },
  { point: FlowCheckpoint.AFTER_EXTERNAL_CALL, mode: 'hang' },
  { point: FlowCheckpoint.BEFORE_COMMIT, mode: 'throw' },
  { point: FlowCheckpoint.AFTER_COMMIT, mode: 'throw' },
  { point: FlowCheckpoint.AFTER_COMMIT, mode: 'hang' },
];

describe('crash and resume injection at every step boundary of the funding flow', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  const firedCases: string[] = [];

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { payments: true });
    payments = harness.payments!;
  });
  afterAll(async () => harness?.close());

  it('the scenarios cover every transition of the table (enumerated, not hand-picked)', () => {
    const covered = new Set(SCENARIOS.filter((scenario) => scenario.from !== scenario.to).map((scenario) => `${scenario.from}→${scenario.to}`));
    expect([...covered, ...NOT_EXECUTED_IN_PHASE_5].sort()).toEqual(fundingTransitions().map(([from, to]) => `${from}→${to}`).sort());
  });

  const cases = SCENARIOS.flatMap((scenario) =>
    BOUNDARIES.map((boundary) => ({ ...scenario, ...boundary, name: `${scenario.from}→${scenario.to}${scenario.manualCapture ? ' (capture requested)' : ''} | ${boundary.mode} ${boundary.point}` })),
  );

  const flowState = async (flowId: string) =>
    ((await harness.dataSource.query(`SELECT state FROM flow_instances WHERE id = $1`, [flowId])) as { state: string }[])[0].state;
  const paymentIdOf = async (flowId: string) =>
    ((await harness.dataSource.query(`SELECT provider_payment_id FROM funding_payments WHERE flow_id = $1`, [flowId])) as {
      provider_payment_id: string;
    }[])[0].provider_payment_id;

  it.each(cases)('$name', async (testCase) => {
    const { psp, runner, checkpoints } = payments;
    psp.setCaptureCompletion(testCase.manualCapture ? 'manual' : 'immediate');
    for (const event of psp.pendingWebhooks()) psp.drop(event.id);
    checkpoints.disarm();
    const before = psp.statistics();
    const user = await payments.signUp();
    const response = await payments.fund(user, { amount: '150000', currency: 'NGN', paymentMethodToken: testCase.token }).expect(202);
    const flowId = (response.body as { fundingId: string }).fundingId;

    // Bring the flow to the state whose step we will crash.
    for (let step = 0; step < 5 && (await flowState(flowId)) !== testCase.from; step += 1) {
      await runner.advance(flowId, { maxSteps: 1 });
    }
    expect(await flowState(flowId)).toBe(testCase.from);
    if (testCase.chargeback) psp.chargeback(await paymentIdOf(flowId));

    // Crash once, at the boundary.
    const fired = checkpoints.arm({ state: testCase.from, point: testCase.point, mode: testCase.mode });
    const step = runner.advance(flowId, { maxSteps: 1, includeCompleted: true }).catch(() => undefined);
    const outcome = await Promise.race([fired.then(() => 'fired' as const), step.then(() => 'finished' as const)]);
    const stepHasExternalCall = testCase.from !== FundingState.CAPTURED;
    if (testCase.point === FlowCheckpoint.AFTER_EXTERNAL_CALL && !stepHasExternalCall) {
      expect(outcome).toBe('finished'); // CAPTURED → POSTED is database-only: no such boundary
    } else {
      expect(checkpoints.hasFired).toBe(true);
      firedCases.push(testCase.name);
    }
    if (testCase.mode === 'throw') await step;
    checkpoints.disarm();

    // Restart: a killed worker's lease lapses; the resumer (and the webhook processor) take over.
    await payments.lapseLeases();
    await payments.drive();
    if (testCase.manualCapture && psp.statusOf(await paymentIdOf(flowId)) === 'capture_pending') {
      psp.completeCapture(await paymentIdOf(flowId));
      await payments.drive();
    }

    expect(await flowState(flowId)).toBe(testCase.final);
    const transactions = (await harness.dataSource.query(`SELECT type, reference FROM transactions WHERE user_id = $1 ORDER BY booking_time`, [
      user.userId,
    ])) as { type: string; reference: string }[];
    const expectedTransactions =
      testCase.final === FundingState.FAILED
        ? []
        : testCase.chargeback
          ? [{ type: 'FUNDING', reference: `funding:${flowId}` }, { type: 'REVERSAL', reference: `chargeback:${flowId}` }]
          : [{ type: 'FUNDING', reference: `funding:${flowId}` }];
    expect(transactions).toEqual(expectedTransactions);
    const after = psp.statistics();
    expect(after.effectiveAuthorizations - before.effectiveAuthorizations).toBe(1);
    expect(after.effectiveCaptures - before.effectiveCaptures).toBe(testCase.captures);
    const [account] = (await harness.dataSource.query(
      `SELECT accounts.balance_minor::text AS balance FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id WHERE wallets.user_id = $1`,
      [user.userId],
    )) as { balance: string }[];
    expect(account.balance).toBe(testCase.final === FundingState.POSTED ? '150000' : '0');
    await harness.expectCleanBooks();
  });

  it('every boundary that exists was actually crashed (the injection really ran)', () => {
    // 7 scenarios × 5 boundaries, minus the 2 after-external-call boundaries of the database-only CAPTURED step.
    expect(firedCases).toHaveLength(cases.length - 2);
  });

  it('a zombie worker that wakes up after its lease lapsed cannot commit: fenced by the lease token, no double posting', async () => {
    const { psp, runner, checkpoints, resumer } = payments;
    psp.setCaptureCompletion('immediate');
    // A worker stalls after its PSP call, before its transaction; its lease lapses and another worker finishes.
    const second = await payments.signUp();
    const secondResponse = await payments.fund(second, { amount: '150000', currency: 'NGN', paymentMethodToken: 'tok_success_zombie' }).expect(202);
    const secondFlow = (secondResponse.body as { fundingId: string }).fundingId;
    await runner.advance(secondFlow, { maxSteps: 1 }); // AUTHORIZED
    const stalled = checkpoints.arm({ state: FundingState.AUTHORIZED, point: FlowCheckpoint.AFTER_EXTERNAL_CALL, mode: 'pause' });
    const lateWorker = runner.advance(secondFlow, { maxSteps: 1 });
    await stalled;
    checkpoints.disarm();
    await payments.lapseLeases();
    await payments.makeAllDue();
    await resumer.resumeDue(100); // another worker takes the lapsed lease and moves the flow on
    await payments.drive();
    expect(await flowState(secondFlow)).toBe(FundingState.POSTED);
    checkpoints.resume();
    const result = await lateWorker;
    expect(result.kind === 'RAN' ? result.outcomes[0].kind : result.kind).toBe('WAITING'); // lease lost: discarded
    const postings = (await harness.dataSource.query(`SELECT count(*)::int AS n FROM transactions WHERE user_id = $1`, [second.userId])) as {
      n: number;
    }[];
    expect(postings[0].n).toBe(1);
    await harness.expectCleanBooks();
  });
});
