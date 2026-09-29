import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { PSP_WEBHOOK_PATH } from '../../src/app.setup';
import { FlowRepository } from '../../src/modules/flows/flow.repository';
import { ClaimedFlow } from '../../src/modules/flows/flow.types';
import { LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

/**
 * Funding under contention (design §6.5, §7.3, §7.5). Per CLAUDE.md: the pool is warmed
 * first (so "parallel" work really is parallel), contending commands are issued back to
 * back, and each test was proven able to fail by mutating the guard it relies on
 * (`scripts/mutation-check.sh`).
 */
describe('funding under concurrency (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  const POOL_SIZE = 10;

  beforeAll(async () => {
    harness = await startLedgerHarness({ DB_POOL_MAX: String(POOL_SIZE) }, { payments: true });
    payments = harness.payments!;
  });
  afterAll(async () => harness?.close());
  beforeEach(() => {
    payments.psp.setCaptureCompletion('immediate');
    for (const event of payments.psp.pendingWebhooks()) payments.psp.drop(event.id);
  });

  async function warmPool(): Promise<void> {
    await Promise.all(Array.from({ length: POOL_SIZE }, () => harness.dataSource.query('SELECT pg_sleep(0.2)')));
  }

  const body = { amount: '150000', currency: 'NGN', paymentMethodToken: 'tok_success_concurrent' };
  const flowIdsOf = async (userId: string) =>
    ((await harness.dataSource.query(`SELECT id FROM flow_instances WHERE user_id = $1`, [userId])) as { id: string }[]).map((row) => row.id);
  const stateOf = async (flowId: string) =>
    ((await harness.dataSource.query(`SELECT state FROM flow_instances WHERE id = $1`, [flowId])) as { state: string }[])[0].state;
  const balanceOfUser = async (userId: string) =>
    (
      (await harness.dataSource.query(
        `SELECT accounts.balance_minor::text AS balance FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id WHERE wallets.user_id = $1`,
        [userId],
      )) as { balance: string }[]
    )[0].balance;

  async function fundAndAuthorize(user: SignedUpUser): Promise<string> {
    const response = await payments.fund(user, body).expect(202);
    const flowId = (response.body as { fundingId: string }).fundingId;
    await payments.runner.advance(flowId, { maxSteps: 1 });
    return flowId;
  }

  it('50 parallel POST /wallet/fund with one key: one flow, one PSP authorization; the rest replay or are REQUEST_IN_PROGRESS', async () => {
    const user = await payments.signUp();
    const authorizationsBefore = payments.psp.statistics().effectiveAuthorizations;
    const key = randomUUID();
    await warmPool();
    const responses = await Promise.all(Array.from({ length: 50 }, () => payments.fund(user, body, key)));

    const created = responses.filter((response) => response.status === 202 && response.headers['idempotent-replayed'] === undefined);
    const replayed = responses.filter((response) => response.status === 202 && response.headers['idempotent-replayed'] === 'true');
    const inProgress = responses.filter((response) => response.status === 409 && response.body.code === 'REQUEST_IN_PROGRESS');
    expect({ created: created.length, others: replayed.length + inProgress.length }).toEqual({ created: 1, others: 49 });
    expect(inProgress.length).toBeGreaterThan(0); // they really did arrive together
    for (const response of replayed) expect(response.text).toBe(created[0].text);
    for (const response of inProgress) expect(response.headers['retry-after']).toBe('1');

    expect(await flowIdsOf(user.userId)).toHaveLength(1);
    await payments.drive();
    expect(payments.psp.statistics().effectiveAuthorizations - authorizationsBefore).toBe(1);
    expect(await balanceOfUser(user.userId)).toBe('150000');
    await harness.expectCleanBooks();
  });

  it('the same webhook delivered 20 times in parallel: one webhook_events row, one credit', async () => {
    const { psp, processor } = payments;
    psp.setCaptureCompletion('manual');
    const user = await payments.signUp();
    const flowId = await fundAndAuthorize(user);
    await payments.runner.advance(flowId, { maxSteps: 1 }); // capture requested, pending
    const [{ provider_payment_id: paymentId }] = (await harness.dataSource.query(`SELECT provider_payment_id FROM funding_payments WHERE flow_id = $1`, [
      flowId,
    ])) as { provider_payment_id: string }[];
    for (const event of psp.pendingWebhooks()) psp.drop(event.id);
    psp.completeCapture(paymentId);
    const [captured] = psp.pendingWebhooks();
    const signature = psp.sign(captured.body);

    await warmPool();
    const statuses = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(harness.auth!.app.getHttpServer())
          .post(PSP_WEBHOOK_PATH)
          .set('Content-Type', 'application/json')
          .set('X-Psp-Signature', signature)
          .send(captured.body.toString('utf8'))
          .then((response) => response.status),
      ),
    );
    expect(statuses).toEqual(Array.from({ length: 20 }, () => 202));
    const rows = (await harness.dataSource.query(`SELECT id FROM webhook_events WHERE provider_event_id = $1`, [captured.id])) as unknown[];
    expect(rows).toHaveLength(1);

    await Promise.all([processor.processDue(100), processor.processDue(100), processor.processDue(100)]);
    await payments.drive({ deliverWebhooks: false });
    expect(await stateOf(flowId)).toBe('POSTED');
    expect(await balanceOfUser(user.userId)).toBe('150000');
    await harness.expectCleanBooks();
  });

  it('the resumer and the webhook processor advancing the same flows at the same moment: one transition per step, one posting', async () => {
    const { psp, processor, resumer } = payments;
    psp.setCaptureCompletion('manual');
    const users = await Promise.all(Array.from({ length: 8 }, () => payments.signUp()));
    const flows: string[] = [];
    for (const user of users) {
      const flowId = await fundAndAuthorize(user);
      await payments.runner.advance(flowId, { maxSteps: 1 }); // capture pending
      flows.push(flowId);
    }
    for (const event of psp.pendingWebhooks()) psp.drop(event.id);
    for (const flowId of flows) {
      const [{ provider_payment_id: paymentId }] = (await harness.dataSource.query(`SELECT provider_payment_id FROM funding_payments WHERE flow_id = $1`, [
        flowId,
      ])) as { provider_payment_id: string }[];
      psp.completeCapture(paymentId);
    }
    await psp.deliverAll(); // stored, not yet processed
    await payments.makeAllDue();

    await warmPool();
    await Promise.all([processor.processDue(100), resumer.resumeDue(100), processor.processDue(100), resumer.resumeDue(100)]);
    await payments.drive({ deliverWebhooks: false });

    for (const [index, flowId] of flows.entries()) {
      expect(await stateOf(flowId)).toBe('POSTED');
      const transitions = (await harness.dataSource.query(
        `SELECT before->>'flowState' || '→' || (after->>'flowState') AS transition FROM audit_logs
          WHERE subject_id = $1 AND action = 'FUNDING_STATE_CHANGED' ORDER BY occurred_at, id`,
        [flowId],
      )) as { transition: string }[];
      expect(transitions.map((row) => row.transition)).toEqual(['INITIATED→AUTHORIZED', 'AUTHORIZED→CAPTURED', 'CAPTURED→POSTED']);
      expect(await balanceOfUser(users[index].userId)).toBe('150000');
    }
    await harness.expectCleanBooks();
  });

  it('several resumers over many due flows: no flow claimed twice at once, none skipped (SKIP LOCKED)', async () => {
    const { psp, resumer } = payments;
    const repository = harness.moduleRef.get(FlowRepository);
    const claims: string[][] = [];
    const original = repository.claimDue.bind(repository);
    const spy = jest.spyOn(repository, 'claimDue').mockImplementation(async (batchSize: number, leaseSeconds: number) => {
      const claimed: ClaimedFlow[] = await original(batchSize, leaseSeconds);
      claims.push(claimed.map((flow) => flow.id));
      return claimed;
    });
    try {
      const users = await Promise.all(Array.from({ length: 40 }, () => payments.signUp()));
      const flows: string[] = [];
      for (const user of users) flows.push((await payments.fund(user, body).expect(202)).body.fundingId as string);
      const before = psp.statistics();

      await warmPool();
      claims.length = 0;
      await Promise.all(Array.from({ length: 4 }, () => resumer.resumeDue(10)));
      const firstRound = claims.flat();
      expect(new Set(firstRound).size).toBe(firstRound.length); // never the same flow twice
      expect(firstRound.length).toBe(40); // none skipped: 4 × 10 distinct flows

      for (let round = 0; round < 10; round += 1) {
        await payments.makeAllDue();
        claims.length = 0;
        const ran = await Promise.all(Array.from({ length: 4 }, () => resumer.resumeDue(10)));
        const ids = claims.flat();
        expect(new Set(ids).size).toBe(ids.length);
        if (ran.every((count) => count === 0)) break;
      }
      for (const flowId of flows) expect(await stateOf(flowId)).toBe('POSTED');
      const after = psp.statistics();
      // One authorization and one capture per flow: no side effect ran twice.
      expect(after.requests.authorize - before.requests.authorize).toBe(40);
      // One lookup per flow, plus only what PSP failures explain: the test's 300ms per-attempt
      // timeout makes a slow lookup retry (reads are retried) and a slow authorize re-run its
      // step, which looks the payment up first. Extra lookups without a failure = a step ran twice.
      const [calls] = (await harness.dataSource.query(
        `SELECT count(*) FILTER (WHERE operation = 'find-payment-by-reference')::int AS lookups,
                count(*) FILTER (WHERE error IS NOT NULL OR response_status >= 500)::int AS failures
           FROM provider_calls WHERE flow_id = ANY($1::uuid[])`,
        [flows],
      )) as { lookups: number; failures: number }[];
      expect(after.requests.list - before.requests.list).toBe(calls.lookups);
      expect(calls.lookups).toBeGreaterThanOrEqual(40);
      expect(calls.lookups - 40).toBeLessThanOrEqual(calls.failures);
      expect(after.effectiveCaptures - before.effectiveCaptures).toBe(40);
      await harness.expectCleanBooks();
    } finally {
      spy.mockRestore();
    }
  });
});
