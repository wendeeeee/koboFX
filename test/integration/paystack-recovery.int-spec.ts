import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { FlowCheckpoint } from '../../src/modules/flows/flow.types';
import { LedgerHarness, PaymentsHarness, PaystackHarness, startLedgerHarness } from '../support/ledger-harness';

describe('Paystack recovery and interleavings', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let paystack: PaystackHarness;
  beforeAll(async () => {
    harness = await startLedgerHarness({}, { paystack: true });
    payments = harness.payments!;
    paystack = payments.paystack!;
  });
  afterAll(async () => harness?.close());
  beforeEach(async () => {
    payments.checkpoints.disarm();
    paystack.mock.dropWebhooks();
    await payments.clearRateLimits();
  });

  async function postings(flowId: string): Promise<number> {
    const rows = await harness.dataSource.query('SELECT id FROM transactions WHERE reference = $1', [`funding:${flowId}`]);
    return rows.length;
  }

  it.each(['INITIATED', 'CHECKOUT_READY'].flatMap((state) => Object.values(FlowCheckpoint).map((point) => [state, point] as const)))(
    'resumes a crash in %s at %s with one provider transaction and one posting', async (state, point) => {
      const user = await payments.signUp();
      const created = await paystack.fund(user, { amount: '150000', currency: 'NGN' }).expect(202);
      const flowId = created.body.fundingId as string;
      if (state === 'CHECKOUT_READY') {
        await payments.runner.advance(flowId);
        paystack.mock.pay(flowId);
      }
      void payments.checkpoints.arm({ state, point, mode: 'throw' });
      await payments.runner.advance(flowId, { maxSteps: 1 }).catch(() => undefined);
      expect(payments.checkpoints.hasFired).toBe(true);
      payments.checkpoints.disarm();
      // If initialize's response was lost, verify can still recover a payment already received.
      if (state === 'INITIATED') paystack.mock.pay(flowId);
      await payments.lapseLeases();
      await payments.drive({ deliverWebhooks: false });
      expect((await paystack.status(user, flowId)).body.status).toBe('COMPLETED');
      expect(await postings(flowId)).toBe(1);
      expect(paystack.mock.transactionsFor(flowId)).toBe(1);
      await harness.expectCleanBooks();
    },
  );

  it('a webhook racing several resumers and a request replay posts exactly once', async () => {
    const user = await payments.signUp();
    const key = randomUUID();
    const body = { amount: '150000', currency: 'NGN' };
    const created = await paystack.fund(user, body, key).expect(202);
    const flowId = created.body.fundingId as string;
    await payments.runner.advance(flowId);
    paystack.mock.pay(flowId);
    await paystack.mock.deliverAll();
    await payments.makeAllDue();
    const [, , , replay] = await Promise.all([
      payments.processor.processDue(100), payments.resumer.resumeDue(100), payments.resumer.resumeDue(100),
      paystack.fund(user, body, key),
    ]);
    expect(replay.text).toBe(created.text);
    await payments.drive();
    expect(await postings(flowId)).toBe(1);
    await harness.expectCleanBooks();
  });

  it('property: verify truth, crashes, webhook delivery, resumer and replay preserve the books after every step', async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom('success', 'amount_mismatch', 'currency_mismatch', 'abandoned'),
      fc.array(fc.constantFrom('webhook', 'resume', 'crash', 'replay'), { minLength: 4, maxLength: 12 }),
      async (outcome, commands) => {
        await payments.clearRateLimits();
        paystack.mock.dropWebhooks();
        const user = await payments.signUp();
        const key = randomUUID();
        const body = { amount: '150000', currency: 'NGN' };
        const created = await paystack.fund(user, body, key).expect(202);
        const flowId = created.body.fundingId as string;
        await payments.runner.advance(flowId);
        if (outcome === 'abandoned') paystack.mock.setStatus(flowId, 'abandoned');
        else paystack.mock.pay(flowId, outcome === 'amount_mismatch' ? { amount: '149999' } : outcome === 'currency_mismatch' ? { currency: 'USD' } : {});
        for (const command of commands) {
          if (command === 'webhook') {
            await paystack.mock.deliverAll();
            await payments.processor.processDue(100);
          } else if (command === 'resume') {
            await payments.makeAllDue();
            await payments.resumer.resumeDue(100);
          } else if (command === 'crash') {
            void payments.checkpoints.arm({ state: 'CHECKOUT_READY', point: FlowCheckpoint.BEFORE_COMMIT, mode: 'throw' });
            await payments.runner.advance(flowId).catch(() => undefined);
            payments.checkpoints.disarm();
            await payments.lapseLeases();
          } else {
            expect((await paystack.fund(user, body, key)).text).toBe(created.text);
          }
          expect(await postings(flowId)).toBeLessThanOrEqual(outcome === 'success' ? 1 : 0);
          await harness.expectCleanBooks();
        }
        await payments.drive();
        expect(await postings(flowId)).toBe(outcome === 'success' ? 1 : 0);
        await harness.expectCleanBooks();
      },
    ), { numRuns: 12, seed: 20261001 });
  }, 240_000);
});
