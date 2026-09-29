import { API_PREFIX } from '../../src/app.setup';
import { Money } from '../../src/common/money';
import { FlowMetrics } from '../../src/modules/flows/flow-metrics';
import { EntryDirection, PostingAuthorization, TransactionType } from '../../src/modules/ledger/ledger.types';
import { LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';
import request from 'supertest';

/**
 * The funding flow (design §7.5; handbook Appendix B, Flow 2) against the simulated PSP
 * over real HTTP, real Postgres and Redis. The worker's loops are played by the test
 * (`resumer.resumeDue`, `processor.processDue`, `psp.deliver…`), so every interleaving
 * is explicit.
 */
describe('funding flow (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { payments: true });
    payments = harness.payments!;
  });
  afterAll(async () => harness?.close());

  beforeEach(() => {
    const { psp } = payments;
    psp.setCaptureCompletion('immediate');
    psp.setReadLag(0);
    psp.clearFaults();
    payments.checkpoints.disarm();
    // Each test starts with an empty webhook queue (anything left over is "lost").
    for (const event of psp.pendingWebhooks()) psp.drop(event.id);
  });

  const body = (amount = '150000', token = 'tok_success_visa', currency = 'NGN') => ({ amount, currency, paymentMethodToken: token });

  async function startFunding(user: SignedUpUser, fundingBody = body()): Promise<string> {
    const response = await payments.fund(user, fundingBody);
    expect(response.status).toBe(202);
    return (response.body as { fundingId: string }).fundingId;
  }

  const accountOf = async (userId: string, currency = 'NGN') =>
    (
      (await harness.dataSource.query(
        `SELECT accounts.id FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id
          WHERE wallets.user_id = $1 AND accounts.currency_code = $2`,
        [userId, currency],
      )) as { id: string }[]
    )[0].id;

  const flowOf = async (flowId: string) =>
    (
      (await harness.dataSource.query(
        `SELECT flow_instances.state, flow_instances.last_error, flow_instances.completed_at, funding_payments.*,
                funding_payments.amount_minor::text AS amount_minor
           FROM flow_instances JOIN funding_payments ON funding_payments.flow_id = flow_instances.id
          WHERE flow_instances.id = $1`,
        [flowId],
      )) as {
        state: string;
        last_error: string | null;
        completed_at: Date | null;
        provider_payment_id: string | null;
        payment_method_token: string | null;
        failure_code: string | null;
        funding_transaction_id: string | null;
        chargeback_transaction_id: string | null;
        captured_at: Date | null;
        capture_requested_at: Date | null;
      }[]
    )[0];

  const fundingTransactionsOf = async (userId: string) =>
    (await harness.dataSource.query(
      `SELECT id, reference, type, status, external_reference, value_time FROM transactions WHERE user_id = $1 ORDER BY booking_time, id`,
      [userId],
    )) as { id: string; reference: string; type: string; status: string; external_reference: string | null; value_time: Date }[];

  const entriesOf = async (transactionId: string) =>
    (await harness.dataSource.query(
      `SELECT accounts.code, ledger_entries.direction, ledger_entries.amount_minor::text AS amount_minor
         FROM ledger_entries JOIN accounts ON accounts.id = ledger_entries.account_id
        WHERE ledger_entries.transaction_id = $1 ORDER BY ledger_entries.direction::text DESC`,
      [transactionId],
    )) as { code: string; direction: string; amount_minor: string }[];

  /** Resume until the flow stops moving (bounded). */
  async function resumeUntilQuiet(rounds = 8): Promise<void> {
    for (let round = 0; round < rounds; round += 1) {
      await payments.makeAllDue();
      if ((await payments.resumer.resumeDue(100)) === 0) return;
    }
  }

  describe('the happy path', () => {
    it('authorized → balance unchanged; webhook → PSP queried → captured → posted: exactly the amount, through PSP_RECEIVABLE', async () => {
      const { psp, resumer, processor } = payments;
      psp.setCaptureCompletion('manual');
      const user = await payments.signUp();
      const flowId = await startFunding(user);
      const account = await accountOf(user.userId);

      await resumer.resumeDue(100); // INITIATED → AUTHORIZED
      expect((await flowOf(flowId)).state).toBe('AUTHORIZED');
      expect(await harness.balanceOf(account)).toBe(0n); // never credited at authorization
      expect(await fundingTransactionsOf(user.userId)).toEqual([]);
      expect((await flowOf(flowId)).payment_method_token).toBeNull(); // the token is gone once the PSP answered

      await resumer.resumeDue(100); // capture requested; pending at the PSP
      const pending = await flowOf(flowId);
      expect(pending.state).toBe('AUTHORIZED');
      expect(pending.capture_requested_at).not.toBeNull();
      expect(await harness.balanceOf(account)).toBe(0n);

      psp.completeCapture(pending.provider_payment_id!);
      const statuses = await psp.deliverAll();
      expect(statuses.every((status) => status === 202)).toBe(true);
      await processor.processDue(100); // the webhook is a trigger: the processor asks the API

      const done = await flowOf(flowId);
      expect(done.state).toBe('POSTED');
      expect(done.completed_at).not.toBeNull();
      expect(await harness.balanceOf(account)).toBe(150_000n);

      const [funding] = await fundingTransactionsOf(user.userId);
      expect(funding).toMatchObject({
        reference: `funding:${flowId}`,
        type: TransactionType.FUNDING,
        status: 'POSTED',
        external_reference: pending.provider_payment_id,
      });
      expect(funding.value_time.toISOString()).toBe(done.captured_at!.toISOString());
      expect(await entriesOf(funding.id)).toEqual([
        { code: 'PSP_RECEIVABLE:NGN', direction: 'DEBIT', amount_minor: '150000' },
        { code: expect.stringMatching(/^USER:.+:NGN$/), direction: 'CREDIT', amount_minor: '150000' },
      ]);
      expect(psp.statistics()).toMatchObject({ effectiveAuthorizations: 1, effectiveCaptures: 1 });
      await harness.expectCleanBooks();

      const view = await request(harness.auth!.app.getHttpServer())
        .get(`/${API_PREFIX}/wallet/fund/${flowId}`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      expect(view.body).toMatchObject({ fundingId: flowId, status: 'COMPLETED', amount: '150000', currency: 'NGN', transactionReference: `funding:${flowId}`, failureCode: null });
      const wallet = await request(harness.auth!.app.getHttpServer())
        .get(`/${API_PREFIX}/wallet`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      expect(wallet.body).toEqual({ balances: [{ currency: 'NGN', minorUnit: 2, total: '150000', reserved: '0', available: '150000' }] });
    });

    it('funds another active currency, opening its account on first funding', async () => {
      const user = await payments.signUp();
      const flowId = await startFunding(user, body('2500', 'tok_success_card', 'USD'));
      await resumeUntilQuiet();
      expect((await flowOf(flowId)).state).toBe('POSTED');
      expect(await harness.balanceOf(await accountOf(user.userId, 'USD'))).toBe(2_500n);
      expect(await harness.balanceOf(await accountOf(user.userId, 'NGN'))).toBe(0n);
      await harness.expectCleanBooks();
    });
  });

  describe('webhooks are hints, not facts', () => {
    it('a webhook claiming "captured" while the API says otherwise does NOT credit; the processor retries until the API agrees', async () => {
      const { psp, resumer, processor } = payments;
      psp.setCaptureCompletion('manual');
      const user = await payments.signUp();
      const flowId = await startFunding(user);
      const account = await accountOf(user.userId);
      await resumer.resumeDue(100);
      await resumer.resumeDue(100); // capture pending
      const paymentId = (await flowOf(flowId)).provider_payment_id!;
      for (const event of psp.pendingWebhooks()) psp.drop(event.id);

      const lie = psp.emitWebhook(paymentId, 'payment.captured'); // the API still says capture_pending
      expect(await psp.deliver(lie.id)).toEqual([202]);
      await processor.processDue(100);
      expect((await flowOf(flowId)).state).toBe('AUTHORIZED');
      expect(await harness.balanceOf(account)).toBe(0n);
      const [event] = (await harness.dataSource.query(
        `SELECT processed_at, attempts, last_error FROM webhook_events WHERE provider_event_id = $1`,
        [lie.id],
      )) as { processed_at: Date | null; attempts: number; last_error: string }[];
      expect(event.processed_at).toBeNull(); // not satisfied: it will be retried
      expect(event.last_error).toMatch(/has not confirmed payment.captured/);

      // Now the PSP really captures — and its read API lags the change by three reads.
      psp.setReadLag(3);
      psp.completeCapture(paymentId);
      for (const pending of psp.pendingWebhooks()) psp.drop(pending.id);
      let rounds = 0;
      while ((await flowOf(flowId)).state !== 'POSTED' && rounds < 10) {
        await payments.makeAllDue();
        await processor.processDue(100);
        rounds += 1;
      }
      expect(rounds).toBeGreaterThan(1); // the lag really made it wait
      expect((await flowOf(flowId)).state).toBe('POSTED');
      expect(await harness.balanceOf(account)).toBe(150_000n); // exactly once
      const [processed] = (await harness.dataSource.query(`SELECT outcome FROM webhook_events WHERE provider_event_id = $1`, [lie.id])) as { outcome: string }[];
      expect(processed.outcome).toBe('ADVANCED');
      await harness.expectCleanBooks();
    });

    it('duplicate, reordered and stale webhooks: stored once each, credited once, state never moves backwards', async () => {
      const { psp, processor } = payments;
      const user = await payments.signUp();
      const flowId = await startFunding(user);
      await resumeUntilQuiet(); // the resumer alone gets it to POSTED; webhooks queued meanwhile
      expect((await flowOf(flowId)).state).toBe('POSTED');
      const events = psp.pendingWebhooks();
      expect(events.map((event) => event.type)).toEqual(['payment.authorized', 'payment.capture_pending', 'payment.captured']);

      // Deliver in reverse order, each three times.
      for (const event of [...events].reverse()) expect(await psp.deliver(event.id, 3)).toEqual([202, 202, 202]);
      await processor.processDue(100);
      const rows = (await harness.dataSource.query(
        `SELECT provider_event_id, outcome FROM webhook_events WHERE provider_event_id = ANY($1) ORDER BY provider_event_id`,
        [events.map((event) => event.id)],
      )) as { provider_event_id: string; outcome: string }[];
      expect(rows).toEqual(events.map((event) => ({ provider_event_id: event.id, outcome: 'NO_CHANGE' })));
      expect(await harness.balanceOf(await accountOf(user.userId))).toBe(150_000n);
      expect(await fundingTransactionsOf(user.userId)).toHaveLength(1);
      const transitions = (await harness.dataSource.query(
        `SELECT after->>'flowState' AS state FROM audit_logs WHERE subject_id = $1 AND action = 'FUNDING_STATE_CHANGED' ORDER BY occurred_at, id`,
        [flowId],
      )) as { state: string }[];
      expect(transitions.map((row) => row.state)).toEqual(['AUTHORIZED', 'CAPTURED', 'POSTED']);
      // Each delivery was recorded as evidence.
      const [{ deliveries }] = (await harness.dataSource.query(
        `SELECT count(*)::int AS deliveries FROM provider_calls WHERE direction = 'INBOUND' AND webhook_event_id IN
           (SELECT id FROM webhook_events WHERE provider_event_id = ANY($1))`,
        [events.map((event) => event.id)],
      )) as { deliveries: number }[];
      expect(deliveries).toBe(9);
      await harness.expectCleanBooks();
    });

    it('the webhook that never arrives: the resumer alone completes the flow by querying the PSP', async () => {
      const { psp } = payments;
      psp.setCaptureCompletion({ afterMilliseconds: 50 });
      const user = await payments.signUp();
      const flowId = await startFunding(user);
      for (let round = 0; round < 20 && (await flowOf(flowId)).state !== 'POSTED'; round += 1) {
        await payments.drive({ deliverWebhooks: false, rounds: 1 });
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect((await flowOf(flowId)).state).toBe('POSTED');
      expect(psp.pendingWebhooks().length).toBeGreaterThan(0); // none was ever delivered
      expect(await harness.balanceOf(await accountOf(user.userId))).toBe(150_000n);
      await harness.expectCleanBooks();
    });
  });

  describe('failures end FAILED with nothing posted', () => {
    it.each([
      ['declined at authorization', 'tok_decline_insufficient_funds', 'DECLINED:insufficient_funds', { captures: 0 }],
      ['authorization expired before capture', 'tok_expire_hold', 'EXPIRED', { captures: 0 }],
      ['capture failed', 'tok_capture_fail_issuer', 'CAPTURE_FAILED', { captures: 0 }],
    ])('%s', async (_name, token, failureCode, expected) => {
      const before = payments.psp.statistics().effectiveCaptures;
      const user = await payments.signUp();
      const flowId = await startFunding(user, body('150000', token));
      await resumeUntilQuiet();
      const flow = await flowOf(flowId);
      expect(flow).toMatchObject({ state: 'FAILED', failure_code: failureCode, payment_method_token: null, funding_transaction_id: null });
      expect(flow.completed_at).not.toBeNull();
      expect(payments.psp.statistics().effectiveCaptures - before).toBe(expected.captures);
      expect(await fundingTransactionsOf(user.userId)).toEqual([]);
      expect(await harness.balanceOf(await accountOf(user.userId))).toBe(0n);
      const view = await request(harness.auth!.app.getHttpServer())
        .get(`/${API_PREFIX}/wallet/fund/${flowId}`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      expect(view.body).toMatchObject({ status: 'FAILED', failureCode, transactionReference: null });
      await harness.expectCleanBooks();
    });

    it('an authorization that expires while waiting ends FAILED', async () => {
      const { psp, resumer } = payments;
      const user = await payments.signUp();
      const flowId = await startFunding(user);
      psp.failNext('capture', 'server_error'); // the capture attempt fails; the hold then lapses
      await resumer.resumeDue(100);
      await resumer.resumeDue(100);
      const paymentId = (await flowOf(flowId)).provider_payment_id!;
      expect((await flowOf(flowId)).state).toBe('AUTHORIZED');
      psp.expireAuthorization(paymentId);
      await resumeUntilQuiet();
      expect(await flowOf(flowId)).toMatchObject({ state: 'FAILED', failure_code: 'EXPIRED' });
      expect(await fundingTransactionsOf(user.userId)).toEqual([]);
    });
  });

  describe('PSP misbehaviour (design §7.2)', () => {
    it('authorize times out AFTER taking effect: the next step finds it by reference — one authorization', async () => {
      const { psp, resumer } = payments;
      const before = psp.statistics();
      psp.failNext('authorize', 'timeout_after_effect');
      const user = await payments.signUp();
      const flowId = await startFunding(user);
      await resumer.resumeDue(100);
      const waiting = await flowOf(flowId);
      expect(waiting.state).toBe('INITIATED');
      expect(waiting.last_error).toMatch(/timed out/);
      await resumeUntilQuiet();
      expect((await flowOf(flowId)).state).toBe('POSTED');
      const after = psp.statistics();
      expect(after.effectiveAuthorizations - before.effectiveAuthorizations).toBe(1);
      expect(after.requests.authorize - before.requests.authorize).toBe(1); // found by reference, not re-sent
    });

    it('authorize times out BEFORE taking effect: re-sent with the same key — still one authorization', async () => {
      const { psp, resumer } = payments;
      const before = psp.statistics();
      psp.failNext('authorize', 'timeout_before_effect');
      const user = await payments.signUp();
      const flowId = await startFunding(user);
      await resumer.resumeDue(100);
      await resumeUntilQuiet();
      expect((await flowOf(flowId)).state).toBe('POSTED');
      const after = psp.statistics();
      expect(after.effectiveAuthorizations - before.effectiveAuthorizations).toBe(1);
      expect(after.requests.authorize - before.requests.authorize).toBe(2);
    });

    it('capture times out after taking effect: re-read, never double-captured', async () => {
      const { psp, resumer } = payments;
      const before = psp.statistics();
      const user = await payments.signUp();
      const flowId = await startFunding(user);
      await resumer.resumeDue(100);
      psp.failNext('capture', 'timeout_after_effect');
      await resumer.resumeDue(100);
      expect((await flowOf(flowId)).last_error).toMatch(/capture timed out/);
      await resumeUntilQuiet();
      expect((await flowOf(flowId)).state).toBe('POSTED');
      expect(psp.statistics().effectiveCaptures - before.effectiveCaptures).toBe(1);
      expect(await harness.balanceOf(await accountOf(user.userId))).toBe(150_000n);
    });

    it('reads survive 5xx, 429, 200-with-error-body and malformed JSON by retrying within the call', async () => {
      const { psp, resumer } = payments;
      const user = await payments.signUp();
      const flowId = await startFunding(user);
      psp.failNext('list', 'server_error');
      psp.failNext('list', 'rate_limited');
      psp.failNext('list', 'error_body_200');
      await resumer.resumeDue(100);
      expect((await flowOf(flowId)).state).toBe('AUTHORIZED');
      psp.failNext('get', 'malformed_json');
      await resumeUntilQuiet();
      expect((await flowOf(flowId)).state).toBe('POSTED');
    });

    it('a malformed field we use fails loudly: the flow waits with the reason and nothing enters the books', async () => {
      const { psp, resumer } = payments;
      const user = await payments.signUp();
      const flowId = await startFunding(user);
      await resumer.resumeDue(100);
      psp.failNext('get', 'bad_field', 4); // every attempt of the next read returns amount as a JSON number
      await payments.makeAllDue();
      await resumer.resumeDue(100);
      const waiting = await flowOf(flowId);
      expect(waiting.state).toBe('AUTHORIZED');
      expect(waiting.last_error).toMatch(/Malformed payment from the PSP: amount/);
      await resumeUntilQuiet();
      expect((await flowOf(flowId)).state).toBe('POSTED');
    });
  });

  describe('a suspended user (§5 point 14)', () => {
    const suspend = (userId: string) => harness.dataSource.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [userId]);

    it('suspended before authorization: FAILED, the card is never touched', async () => {
      const { psp } = payments;
      const before = psp.statistics().requests.authorize;
      const user = await payments.signUp();
      const flowId = await startFunding(user);
      await suspend(user.userId);
      await resumeUntilQuiet();
      expect(await flowOf(flowId)).toMatchObject({ state: 'FAILED', failure_code: 'USER_SUSPENDED' });
      expect(psp.statistics().requests.authorize).toBe(before);
    });

    it('suspended after authorization, before capture: the hold is voided, FAILED', async () => {
      const { psp, resumer } = payments;
      const before = psp.statistics();
      const user = await payments.signUp();
      const flowId = await startFunding(user);
      await resumer.resumeDue(100);
      await suspend(user.userId);
      await resumeUntilQuiet();
      expect(await flowOf(flowId)).toMatchObject({ state: 'FAILED', failure_code: 'USER_SUSPENDED' });
      const after = psp.statistics();
      expect(after.effectiveVoids - before.effectiveVoids).toBe(1);
      expect(after.effectiveCaptures - before.effectiveCaptures).toBe(0);
    });

    it('suspended after capture was requested: it still posts — the card was charged, we owe it', async () => {
      const { psp, resumer } = payments;
      psp.setCaptureCompletion('manual');
      const user = await payments.signUp();
      const flowId = await startFunding(user);
      await resumer.resumeDue(100);
      await resumer.resumeDue(100);
      await suspend(user.userId);
      psp.completeCapture((await flowOf(flowId)).provider_payment_id!);
      await resumeUntilQuiet();
      expect((await flowOf(flowId)).state).toBe('POSTED');
      expect(await harness.balanceOf(await accountOf(user.userId))).toBe(150_000n);
    });
  });

  describe('chargebacks (§5 point 4)', () => {
    it('a full chargeback is a REVERSAL mirroring the funding entry for entry', async () => {
      const { psp, processor } = payments;
      const user = await payments.signUp();
      const flowId = await startFunding(user);
      await resumeUntilQuiet();
      for (const event of psp.pendingWebhooks()) psp.drop(event.id);
      const paymentId = (await flowOf(flowId)).provider_payment_id!;
      psp.chargeback(paymentId);
      await psp.deliverAll();
      await processor.processDue(100);

      const flow = await flowOf(flowId);
      expect(flow.state).toBe('REVERSED');
      const [funding, reversal] = await fundingTransactionsOf(user.userId);
      expect(funding.status).toBe('REVERSED');
      expect(reversal).toMatchObject({ type: 'REVERSAL', reference: `chargeback:${flowId}`, status: 'POSTED' });
      expect(reversal.external_reference).toMatch(/^cb_/);
      const mirrored = (await entriesOf(funding.id)).map((entry) => ({ ...entry, direction: entry.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT' }));
      expect((await entriesOf(reversal.id)).sort((a, b) => a.code.localeCompare(b.code))).toEqual(mirrored.sort((a, b) => a.code.localeCompare(b.code)));
      expect(await harness.balanceOf(await accountOf(user.userId))).toBe(0n);
      await harness.expectCleanBooks();
    });

    it('a chargeback after the funds were spent drives the balance negative — recorded, never clamped', async () => {
      const { psp, processor } = payments;
      const user = await payments.signUp();
      const flowId = await startFunding(user, body('100000'));
      await resumeUntilQuiet();
      const account = await accountOf(user.userId);
      await harness.ledger.post({
        transaction: {
          type: TransactionType.WITHDRAWAL,
          authorization: PostingAuthorization.USER_INITIATED,
          valueTime: new Date(),
          initiatedBy: `user:${user.userId}`,
          userId: user.userId,
        },
        entries: [
          { account: { accountId: account }, direction: EntryDirection.DEBIT, amount: Money.of(80_000n, 'NGN') },
          { account: { systemAccount: 'BANK' }, direction: EntryDirection.CREDIT, amount: Money.of(80_000n, 'NGN') },
        ],
      });
      for (const event of psp.pendingWebhooks()) psp.drop(event.id);
      psp.chargeback((await flowOf(flowId)).provider_payment_id!);
      await psp.deliverAll();
      await processor.processDue(100);
      expect((await flowOf(flowId)).state).toBe('REVERSED');
      expect(await harness.balanceOf(account)).toBe(-80_000n);
      const report = await harness.expectCleanBooks();
      expect(report.overdrawnAccounts.map((overdrawn) => overdrawn.accountId)).toContain(account);
    });

    it('a partial chargeback is parked for an approved correction: nothing posted, the reason recorded', async () => {
      const { psp, processor } = payments;
      const user = await payments.signUp();
      const flowId = await startFunding(user);
      await resumeUntilQuiet();
      for (const event of psp.pendingWebhooks()) psp.drop(event.id);
      psp.chargeback((await flowOf(flowId)).provider_payment_id!, '50000');
      const [event] = psp.pendingWebhooks();
      await psp.deliverAll();
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await payments.makeAllDue();
        await processor.processDue(100);
      }
      const flow = await flowOf(flowId);
      expect(flow.state).toBe('POSTED');
      expect(flow.last_error).toMatch(/PARTIAL_CHARGEBACK_UNSUPPORTED: 50000 of 150000/);
      expect(flow.chargeback_transaction_id).toBeNull();
      expect(await fundingTransactionsOf(user.userId)).toHaveLength(1);
      const [row] = (await harness.dataSource.query(`SELECT outcome FROM webhook_events WHERE provider_event_id = $1`, [event.id])) as { outcome: string }[];
      expect(row.outcome).toBe('UNCONFIRMED');
    });

    it('a chargeback seen before posting: posted, then reversed by the resumer — no webhook needed', async () => {
      const { psp, resumer } = payments;
      psp.setCaptureCompletion('manual');
      const user = await payments.signUp();
      const flowId = await startFunding(user);
      await resumer.resumeDue(100);
      await resumer.resumeDue(100);
      const paymentId = (await flowOf(flowId)).provider_payment_id!;
      psp.completeCapture(paymentId);
      psp.chargeback(paymentId);
      await resumeUntilQuiet();
      expect((await flowOf(flowId)).state).toBe('REVERSED');
      expect((await fundingTransactionsOf(user.userId)).map((transaction) => transaction.type)).toEqual(['FUNDING', 'REVERSAL']);
      expect(await harness.balanceOf(await accountOf(user.userId))).toBe(0n);
      await harness.expectCleanBooks();
    });
  });

  it('flows_stalled counts incomplete flows whose state has not changed for 30 minutes', async () => {
    const owner = await harness.db.ownerClient();
    try {
      const user = await payments.signUp();
      const flowId = await startFunding(user);
      await payments.resumer.resumeDue(100);
      await owner.query(`UPDATE flow_instances SET state_changed_at = now() - interval '31 minutes' WHERE id = $1`, [flowId]);
      const stalled = await harness.moduleRef.get(FlowMetrics).flowsStalled();
      expect(stalled).toContainEqual({ flowType: 'FUNDING', state: 'AUTHORIZED', count: 1 });
    } finally {
      await owner.end();
    }
  });
});
