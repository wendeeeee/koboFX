import { ReconciliationBreak } from '../../src/modules/reconciliation/break.service';
import { ReconciliationRunKind } from '../../src/modules/reconciliation/reconciliation-schedule';
import { LedgerHarness, PaymentsHarness, PaystackHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

const WINDOW_MINUTES = 5;

/**
 * Paystack reconciliation (PAYSTACK_PLAN.md C7): its own runs (`reconciliation_runs.provider = 'paystack'`), the same
 * break taxonomy, Paystack's ids and our reference only. And the simulated PSP's runs never touch Paystack's breaks.
 */
describe('Paystack reconciliation (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let paystack: PaystackHarness;
  let periodSequence = 0;

  beforeAll(async () => {
    harness = await startLedgerHarness(
      { RECONCILIATION_UNRESOLVED_FLOW_AGE_MINUTES: '1' },
      { paystack: { checkoutWindowMinutes: WINDOW_MINUTES } },
    );
    payments = harness.payments!;
    paystack = payments.paystack!;
  });
  afterAll(async () => harness?.close());

  /** Time passes (forward only): webhooks and flows are old enough to be breaks. */
  const age = (minutes: number) => harness.auth!.clock.advance(minutes * 60_000);

  async function runPaystack(kind: ReconciliationRunKind = ReconciliationRunKind.EXTERNAL_DAILY) {
    periodSequence += 1;
    const key = `${String(3000 + periodSequence)}-01-01${kind === ReconciliationRunKind.EXTERNAL_HOURLY ? 'T00' : ''}`;
    const result = await payments.reconciliation.scheduler.runPeriod(kind, key, 'paystack');
    if (!result) throw new Error('Paystack run not claimed');
    return result as { runId: string; status: string; detectedBreakIds: readonly string[]; resolvedBreakIds: readonly string[] };
  }

  async function breaksOf(breakIds: readonly string[]): Promise<ReconciliationBreak[]> {
    return Promise.all(breakIds.map(async (id) => (await payments.reconciliation.breaks.findById(id))!));
  }

  async function fundToCheckout(user: SignedUpUser, amount: string): Promise<string> {
    const response = await paystack.fund(user, { amount, currency: 'NGN' });
    expect(response.status).toBe(202);
    const fundingId = (response.body as { fundingId: string }).fundingId;
    await payments.runner.advance(fundingId);
    return fundingId;
  }

  const stateOf = async (flowId: string) =>
    ((await harness.dataSource.query(`SELECT state FROM flow_instances WHERE id = $1`, [flowId])) as { state: string }[])[0].state;

  it('a clean day: posted fundings, nothing else → CLEAN, the receivable proven', async () => {
    const user = await payments.signUp();
    const fundingId = await fundToCheckout(user, '25000');
    paystack.mock.pay(fundingId);
    await payments.drive();
    expect(await stateOf(fundingId)).toBe('POSTED');
    age(2);
    const result = await runPaystack();
    expect(result.status).toBe('CLEAN');
    const run = await payments.reconciliation.runs.find(ReconciliationRunKind.EXTERNAL_DAILY, `${3000 + periodSequence}-01-01`, 'paystack');
    expect(run).toMatchObject({ provider: 'paystack', status: 'CLEAN' });
  });

  it('a late success (paid after we failed the funding): PAYMENT_WITHOUT_FLOW naming the failed flow, escalated — never lost', async () => {
    const user = await payments.signUp();
    const fundingId = await fundToCheckout(user, '30000');
    age(WINDOW_MINUTES + 1);
    await payments.runner.advance(fundingId);
    expect(await stateOf(fundingId)).toBe('FAILED');
    paystack.mock.pay(fundingId);
    paystack.mock.dropWebhooks();
    age(2);
    const result = await runPaystack();
    const [late] = (await breaksOf(result.detectedBreakIds)).filter((each) => each.flowId === fundingId);
    expect(late).toMatchObject({ type: 'PAYMENT_WITHOUT_FLOW', status: 'ESCALATED', currency: 'NGN', amountMinor: 30000n });
    expect(late.details).toMatchObject({ lateSuccess: true, failedFlowId: fundingId, paystackStatus: 'success' });
    expect(late.subjectKey).toBe(`payment:paystack:${paystack.mock.find(fundingId)!.id}`);
    // Re-detected on the next run, never duplicated.
    const again = await runPaystack();
    expect(again.detectedBreakIds).toContain(late.id);
    await harness.expectCleanBooks();
  });

  it('a HELD funding raises its mismatch break from the hourly run, escalated', async () => {
    const user = await payments.signUp();
    const fundingId = await fundToCheckout(user, '40000');
    paystack.mock.pay(fundingId, { amount: '39000' });
    await payments.drive();
    expect(await stateOf(fundingId)).toBe('HELD');
    const result = await runPaystack(ReconciliationRunKind.EXTERNAL_HOURLY);
    const [held] = (await breaksOf(result.detectedBreakIds)).filter((each) => each.flowId === fundingId);
    expect(held).toMatchObject({ type: 'AMOUNT_MISMATCH', status: 'ESCALATED', amountMinor: 39000n });
    expect(held.details).toMatchObject({ paystackAmountMinor: '39000', requestedAmountMinor: '40000', flowState: 'HELD', source: 'HELD_FLOW' });
    // The hourly run does not raise it twice.
    const second = await runPaystack(ReconciliationRunKind.EXTERNAL_HOURLY);
    expect(second.detectedBreakIds).not.toContain(held.id);
  });

  it('a payment nobody initialized through us: PAYMENT_WITHOUT_FLOW', async () => {
    const reference = paystack.mock.createForeignTransaction({ amount: '12345', currency: 'NGN' });
    age(2);
    const result = await runPaystack();
    const foreign = (await breaksOf(result.detectedBreakIds)).find((each) => each.details.reference === reference);
    expect(foreign).toMatchObject({ type: 'PAYMENT_WITHOUT_FLOW', status: 'ESCALATED', flowId: null, amountMinor: 12345n });
    expect(foreign?.details).toMatchObject({ lateSuccess: false });
  });

  it('paid at Paystack, the webhook lost and the flow not yet driven: MISSING_IN_LEDGER, resolved by driving the flow', async () => {
    const user = await payments.signUp();
    const fundingId = await fundToCheckout(user, '50000');
    paystack.mock.pay(fundingId);
    paystack.mock.dropWebhooks();
    age(2);
    const result = await runPaystack();
    const [missing] = (await breaksOf(result.detectedBreakIds)).filter((each) => each.flowId === fundingId);
    expect(missing.type).toBe('MISSING_IN_LEDGER');
    expect(result.resolvedBreakIds).toContain(missing.id);
    expect((await payments.reconciliation.breaks.findById(missing.id))?.resolutionKind).toBe('FLOW_ADVANCED');
    expect(await stateOf(fundingId)).toBe('POSTED');
    await harness.expectCleanBooks();
  });

  it('a lost dispute whose webhook never came: CHARGEBACK_NOT_REVERSED, reversed by driving the flow', async () => {
    const user = await payments.signUp();
    const fundingId = await fundToCheckout(user, '60000');
    paystack.mock.pay(fundingId);
    await payments.drive();
    paystack.mock.resolveDispute(paystack.mock.openDispute(fundingId), 'merchant-accepted');
    paystack.mock.dropWebhooks();
    age(2);
    const result = await runPaystack();
    const [dispute] = (await breaksOf(result.detectedBreakIds)).filter((each) => each.flowId === fundingId);
    expect(dispute.type).toBe('CHARGEBACK_NOT_REVERSED');
    expect(result.resolvedBreakIds).toContain(dispute.id);
    expect(await stateOf(fundingId)).toBe('REVERSED');
    await harness.expectCleanBooks();
  });

  it('a booked deposit Paystack now reports reversed: MISSING_AT_PSP', async () => {
    const user = await payments.signUp();
    const fundingId = await fundToCheckout(user, '70000');
    paystack.mock.pay(fundingId);
    await payments.drive();
    paystack.mock.setStatus(fundingId, 'reversed');
    age(2);
    const result = await runPaystack();
    const [missing] = (await breaksOf(result.detectedBreakIds)).filter((each) => each.flowId === fundingId);
    expect(missing).toMatchObject({ type: 'MISSING_AT_PSP', status: 'ESCALATED' });
    expect(missing.details).toMatchObject({ paystackStatus: 'reversed' });
  });

  it('an unmatched Paystack webhook: a break, the stored payload reprocessed', async () => {
    const body = Buffer.from('{"event":"charge.success","data":{"id":424242,"status":"success","reference":"not-ours"}}');
    expect(await paystack.mock.send(body)).toBe(200);
    await payments.processor.processDue(100);
    const result = await runPaystack();
    const unmatched = (await breaksOf(result.detectedBreakIds)).find((each) => each.type === 'UNMATCHED_WEBHOOK');
    expect(unmatched).toMatchObject({ status: 'ESCALATED' });
  });

  it('the simulated PSP\'s run never sweeps Paystack\'s breaks, and Paystack\'s never sweeps the PSP\'s', async () => {
    const live = (await payments.reconciliation.liveBreaks()).filter((each) => each.subjectKey.startsWith('payment:paystack:'));
    expect(live.length).toBeGreaterThan(0);
    const before = new Map(live.map((each) => [each.id, each.status]));
    const simulated = (await payments.reconciliation.run(ReconciliationRunKind.EXTERNAL_DAILY)) as { detectedBreakIds: readonly string[] };
    expect(simulated.detectedBreakIds.filter((id) => before.has(id))).toEqual([]);
    for (const [id, status] of before) {
      const after = await payments.reconciliation.breaks.findById(id);
      expect(after?.status).toBe(status);
      expect(JSON.stringify(after?.details ?? {})).not.toMatch(/No longer detected by external run/);
    }
  });
});
