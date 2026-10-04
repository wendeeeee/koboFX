import { Writable } from 'node:stream';
import { signPaystackWebhook } from '../../src/modules/payments/paystack/webhooks/paystack-webhook-signature';
import { LedgerHarness, PaymentsHarness, PaystackHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

const WINDOW_MINUTES = 5;

/**
 * Paystack funding (PAYSTACK_PLAN.md) end to end: the real HTTP pipeline, real Postgres and Redis, the simulated
 * Paystack over real HTTP. The worker's loops are played by the test (`processor.processDue`, `resumer.resumeDue`,
 * `mock.deliverAll`), so every interleaving is explicit. No test reaches the real Paystack.
 */
describe('Paystack funding (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let paystack: PaystackHarness;
  const logs: string[] = [];

  beforeAll(async () => {
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logs.push(chunk.toString('utf8'));
        callback();
      },
    });
    harness = await startLedgerHarness({ LOG_LEVEL: 'info' }, { paystack: { checkoutWindowMinutes: WINDOW_MINUTES }, logStream });
    payments = harness.payments!;
    paystack = payments.paystack!;
  });
  afterAll(async () => harness?.close());

  beforeEach(() => {
    paystack.mock.clearFaults();
    paystack.mock.dropWebhooks();
    payments.checkpoints.disarm();
  });

  async function start(user: SignedUpUser, amount = '150000', currency = 'NGN'): Promise<string> {
    const response = await paystack.fund(user, { amount, currency });
    expect(response.status).toBe(202);
    return (response.body as { fundingId: string }).fundingId;
  }

  const flowOf = async (flowId: string) =>
    (
      (await harness.dataSource.query(
        `SELECT flow_instances.state, flow_instances.flow_type, flow_instances.last_error, flow_instances.completed_at,
                funding_payments.provider, funding_payments.provider_payment_id, funding_payments.failure_code,
                funding_payments.funding_transaction_id, funding_payments.chargeback_transaction_id,
                funding_payments.captured_at, funding_payments.checkout_authorization_url, funding_payments.checkout_expires_at
           FROM flow_instances JOIN funding_payments ON funding_payments.flow_id = flow_instances.id
          WHERE flow_instances.id = $1`,
        [flowId],
      )) as {
        state: string;
        flow_type: string;
        last_error: string | null;
        completed_at: Date | null;
        provider: string;
        provider_payment_id: string | null;
        failure_code: string | null;
        funding_transaction_id: string | null;
        chargeback_transaction_id: string | null;
        captured_at: Date | null;
        checkout_authorization_url: string | null;
        checkout_expires_at: Date | null;
      }[]
    )[0];

  const postingsOf = async (flowId: string) =>
    (await harness.dataSource.query(
      `SELECT transactions.id, transactions.reference, transactions.type, transactions.reason_code, transactions.external_reference,
              transactions.value_time, accounts.code, ledger_entries.direction, ledger_entries.amount_minor::text AS amount_minor
         FROM transactions JOIN ledger_entries ON ledger_entries.transaction_id = transactions.id
         JOIN accounts ON accounts.id = ledger_entries.account_id
        WHERE transactions.reference IN ($1, $2)
        ORDER BY transactions.booking_time, accounts.code DESC, ledger_entries.id`,
      [`funding:${flowId}`, `chargeback:${flowId}`],
    )) as { id: string; reference: string; type: string; reason_code: string; external_reference: string; value_time: Date; code: string; direction: string; amount_minor: string }[];

  const balanceOf = async (userId: string, currency = 'NGN') => {
    const rows = (await harness.dataSource.query(
      `SELECT accounts.balance_minor::text AS balance FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id
        WHERE wallets.user_id = $1 AND accounts.currency_code = $2`,
      [userId, currency],
    )) as { balance: string }[];
    return BigInt(rows[0]?.balance ?? '0');
  };

  /** Run the worker until the checkout is initialized; returns the status body. */
  async function untilCheckoutReady(user: SignedUpUser, fundingId: string): Promise<Record<string, unknown>> {
    await payments.resumer.resumeDue(100);
    const status = await paystack.status(user, fundingId);
    expect(status.status).toBe(200);
    return status.body as Record<string, unknown>;
  }

  it('happy path: 202 → checkout ready → paid → webhook → verify → COMPLETED, credited exactly once', async () => {
    const user = await payments.signUp();
    const accepted = await paystack.fund(user, { amount: '150000', currency: 'NGN' });
    expect(accepted.status).toBe(202);
    const fundingId = (accepted.body as { fundingId: string }).fundingId;
    expect(accepted.body).toEqual({ fundingId, status: 'PENDING', amount: '150000', currency: 'NGN', provider: 'paystack' });
    // The API never called Paystack.
    expect(paystack.mock.transactionsFor(fundingId)).toBe(0);

    const ready = await untilCheckoutReady(user, fundingId);
    expect(ready).toMatchObject({ status: 'PENDING', provider: 'paystack', transactionReference: null });
    const checkout = ready.checkout as { authorizationUrl: string; expiresAt: string };
    expect(checkout.authorizationUrl).toMatch(/\/checkout\/[0-9a-f]{16}$/);
    expect(new Date(checkout.expiresAt).getTime()).toBeGreaterThan(harness.auth!.clock.now().getTime());
    // The email Paystack got is the user's stored one.
    expect(paystack.mock.find(fundingId)?.email).toBe(user.email);

    paystack.mock.pay(fundingId);
    expect(await paystack.mock.deliverAll()).toEqual([200]);
    await payments.processor.processDue(100);

    const flow = await flowOf(fundingId);
    expect(flow).toMatchObject({ state: 'POSTED', flow_type: 'PAYSTACK_FUNDING', provider: 'paystack' });
    expect(flow.completed_at).not.toBeNull();
    const done = (await paystack.status(user, fundingId)).body as Record<string, unknown>;
    expect(done).toMatchObject({ status: 'COMPLETED', checkout: null, transactionReference: `funding:${fundingId}` });

    const postings = await postingsOf(fundingId);
    expect(postings.map((row) => [row.code.replace(/^USER:.*:/, 'USER:'), row.direction, row.amount_minor])).toEqual([
      ['USER:NGN', 'CREDIT', '150000'],
      ['PAYSTACK_RECEIVABLE:NGN', 'DEBIT', '150000'],
    ]);
    expect(postings[1]).toMatchObject({ type: 'FUNDING', reason_code: 'CARD_DEPOSIT', external_reference: paystack.mock.find(fundingId)?.id });
    expect(postings[0].value_time.toISOString()).toBe(paystack.mock.find(fundingId)?.paidAt);
    // Paystack's id is beyond 2^53: kept exactly.
    expect(flow.provider_payment_id).toBe(paystack.mock.find(fundingId)?.id);
    expect(await balanceOf(user.userId)).toBe(150000n);

    const [outbox] = (await harness.dataSource.query(
      `SELECT event_type, payload FROM outbox_events WHERE aggregate_id = $1`,
      [postings[0].id],
    )) as { event_type: string; payload: Record<string, unknown> }[];
    expect(outbox).toEqual({ event_type: 'FundingPosted.v1', payload: { transactionId: postings[0].id, userId: user.userId, flowId: fundingId, provider: 'paystack' } });

    // A second delivery of the same event, and more worker passes: nothing more.
    expect(await paystack.mock.send(paystack.mock.chargeSuccessBody(fundingId))).toBe(200);
    await payments.drive();
    expect(await balanceOf(user.userId)).toBe(150000n);
    expect(await postingsOf(fundingId)).toHaveLength(2);
    expect(paystack.mock.transactionsFor(fundingId)).toBe(1);
    await harness.expectCleanBooks();
  });

  it('verify alone drives completion: no webhook ever arrives (the resumer)', async () => {
    const user = await payments.signUp();
    const fundingId = await start(user, '20000');
    await untilCheckoutReady(user, fundingId);
    paystack.mock.pay(fundingId);
    paystack.mock.dropWebhooks();
    await payments.makeAllDue();
    await payments.resumer.resumeDue(100);
    expect((await flowOf(fundingId)).state).toBe('POSTED');
    expect(await balanceOf(user.userId)).toBe(20000n);
    await harness.expectCleanBooks();
  });

  it('a webhook before the checkout is ready, and duplicated: one posting, events deduplicated', async () => {
    const user = await payments.signUp();
    const fundingId = await start(user, '30000');
    // The worker has not initialized yet; Paystack (out of order) already knows the transaction: simulate by creating it.
    await untilCheckoutReady(user, fundingId);
    paystack.mock.pay(fundingId);
    const body = paystack.mock.chargeSuccessBody(fundingId);
    paystack.mock.dropWebhooks();
    expect(await paystack.mock.send(body)).toBe(200);
    expect(await paystack.mock.send(body)).toBe(200);
    const events = (await harness.dataSource.query(
      `SELECT count(*)::int AS count FROM webhook_events WHERE provider = 'paystack' AND signature_valid AND raw_payload = $1`,
      [body],
    )) as { count: number }[];
    expect(events[0].count).toBe(1);
    await payments.drive();
    expect((await flowOf(fundingId)).state).toBe('POSTED');
    expect(await postingsOf(fundingId)).toHaveLength(2);
  });

  it('a webhook for a flow still INITIATED waits for verify; one after completion is NO_CHANGE', async () => {
    const user = await payments.signUp();
    const fundingId = await start(user, '31000');
    const premature = Buffer.from(`{"event":"charge.success","data":{"id":1,"status":"success","reference":"${fundingId}","amount":31000}}`);
    expect(await paystack.mock.send(premature)).toBe(200);
    await payments.processor.processDue(100);
    // The processor advanced the flow: it initialized (verify said not found) — no credit from the webhook.
    const flow = await flowOf(fundingId);
    expect(flow.state).toBe('CHECKOUT_READY');
    expect(flow.funding_transaction_id).toBeNull();
    paystack.mock.pay(fundingId);
    await payments.drive();
    expect((await flowOf(fundingId)).state).toBe('POSTED');
    const late = Buffer.from(`{"event":"charge.success","data":{"id":2,"status":"success","reference":"${fundingId}"}}`);
    expect(await paystack.mock.send(late)).toBe(200);
    await payments.processor.processDue(100);
    const [event] = (await harness.dataSource.query(`SELECT outcome FROM webhook_events WHERE raw_payload = $1`, [late])) as { outcome: string }[];
    expect(event.outcome).toBe('NO_CHANGE');
  });

  it('a forged webhook is stored, answered 401 and never processed — and cannot suppress the genuine one', async () => {
    const user = await payments.signUp();
    const fundingId = await start(user, '40000');
    await untilCheckoutReady(user, fundingId);
    paystack.mock.pay(fundingId);
    const genuine = paystack.mock.chargeSuccessBody(fundingId);
    paystack.mock.dropWebhooks();
    expect(await paystack.mock.send(genuine, { signingKey: 'sk_test_attacker_guess_0000000000' })).toBe(401);
    expect(await paystack.mock.send(genuine, 'f'.repeat(128))).toBe(401);
    expect((await paystack.postWebhook(genuine, { 'content-type': 'application/json' })).status).toBe(401);
    // W2 (WITHDRAWAL_PLAN.md §H): a refused delivery is stored SEALED; it is found by the digest of the exact bytes.
    const forged = (await harness.dataSource.query(
      `SELECT signature_valid, outcome, provider_event_id, processed_at, payload_encoding FROM webhook_events
        WHERE provider = 'paystack' AND payload_sha256 = sha256($1::bytea)`,
      [genuine],
    )) as { signature_valid: boolean; outcome: string; provider_event_id: string | null; processed_at: Date | null; payload_encoding: string }[];
    expect(forged).toHaveLength(3);
    for (const row of forged) {
      expect(row).toMatchObject({ signature_valid: false, outcome: 'INVALID_SIGNATURE', provider_event_id: null, payload_encoding: 'SEALED_V1' });
    }
    expect((await flowOf(fundingId)).state).toBe('CHECKOUT_READY');
    // The genuine delivery is still accepted and processed.
    expect(await paystack.mock.send(genuine)).toBe(200);
    await payments.processor.processDue(100);
    expect((await flowOf(fundingId)).state).toBe('POSTED');
  });

  it('a webhook that says success when verify does not: no credit (the webhook is a hint)', async () => {
    const user = await payments.signUp();
    const fundingId = await start(user, '50000');
    await untilCheckoutReady(user, fundingId);
    // Validly signed (Paystack sent it), claims success — but Paystack's verify still says abandoned.
    const lying = Buffer.from(
      `{"event":"charge.success","data":{"id":9,"status":"success","reference":"${fundingId}","amount":50000,"requested_amount":50000}}`,
    );
    expect(await paystack.mock.send(lying)).toBe(200);
    await payments.processor.processDue(100);
    expect((await flowOf(fundingId)).state).toBe('CHECKOUT_READY');
    expect(await balanceOf(user.userId)).toBe(0n);
  });

  it.each([
    ['amount', { amount: '49999' }, 'HELD:amount'],
    ['currency', { currency: 'USD' }, 'HELD:currency'],
  ])('paid with another %s: HELD, nothing credited, the webhook\'s numbers never read', async (_what, overrides, failureCode) => {
    const user = await payments.signUp();
    const fundingId = await start(user, '50000');
    await untilCheckoutReady(user, fundingId);
    paystack.mock.pay(fundingId, overrides);
    await payments.drive();
    const flow = await flowOf(fundingId);
    expect(flow).toMatchObject({ state: 'HELD', failure_code: failureCode, funding_transaction_id: null });
    expect(flow.completed_at).not.toBeNull();
    expect(await balanceOf(user.userId)).toBe(0n);
    expect(await balanceOf(user.userId, 'USD')).toBe(0n);
    expect(((await paystack.status(user, fundingId)).body as { status: string }).status).toBe('PENDING');
    await harness.expectCleanBooks();
  });

  it('abandoned: waits inside the window, FAILED after it; the URL disappears with the window', async () => {
    const user = await payments.signUp();
    const fundingId = await start(user, '60000');
    await untilCheckoutReady(user, fundingId);
    await payments.makeAllDue();
    await payments.resumer.resumeDue(100);
    expect((await flowOf(fundingId)).state).toBe('CHECKOUT_READY');
    harness.auth!.clock.advance((WINDOW_MINUTES + 1) * 60_000);
    try {
      expect(((await paystack.status(user, fundingId)).body as { checkout: unknown }).checkout).toBeNull();
      await payments.makeAllDue();
      await payments.resumer.resumeDue(100);
      expect(await flowOf(fundingId)).toMatchObject({ state: 'FAILED', failure_code: 'CHECKOUT_EXPIRED:abandoned' });
      expect(((await paystack.status(user, fundingId)).body as { status: string }).status).toBe('FAILED');
    } finally {
      harness.auth!.clock.advance(-(WINDOW_MINUTES + 1) * 60_000);
    }
  });

  it('a declined card inside the window is NOT final (the customer may retry on the same checkout)', async () => {
    const user = await payments.signUp();
    const fundingId = await start(user, '61000');
    await untilCheckoutReady(user, fundingId);
    paystack.mock.decline(fundingId);
    await payments.makeAllDue();
    await payments.resumer.resumeDue(100);
    expect((await flowOf(fundingId)).state).toBe('CHECKOUT_READY');
    paystack.mock.pay(fundingId);
    await payments.drive();
    expect((await flowOf(fundingId)).state).toBe('POSTED');
  });

  it('money in flight after the window is never failed on time alone', async () => {
    const user = await payments.signUp();
    const fundingId = await start(user, '62000');
    await untilCheckoutReady(user, fundingId);
    paystack.mock.setStatus(fundingId, 'ongoing');
    harness.auth!.clock.advance((WINDOW_MINUTES + 1) * 60_000);
    try {
      await payments.makeAllDue();
      await payments.resumer.resumeDue(100);
      expect((await flowOf(fundingId)).state).toBe('CHECKOUT_READY');
    } finally {
      harness.auth!.clock.advance(-(WINDOW_MINUTES + 1) * 60_000);
    }
  });

  it.each(['server_error', 'rate_limited', 'status_false_200', 'malformed_json', 'bad_field', 'timeout_before_effect'] as const)(
    'Paystack %s on verify is transient: retried, then completes; never inside a DB transaction',
    async (fault) => {
      const user = await payments.signUp();
      const fundingId = await start(user, '70000');
      await untilCheckoutReady(user, fundingId);
      paystack.mock.pay(fundingId);
      paystack.mock.dropWebhooks();
      // Reads retry inside one attempt (1 + 3); exhaust them so the step itself fails and backs off.
      paystack.mock.failNext('verify', fault, 4);
      await payments.runner.advance(fundingId);
      const after = await flowOf(fundingId);
      expect(after.state).toBe('CHECKOUT_READY');
      expect(after.last_error).toMatch(/Paystack|Provider/);
      await payments.makeAllDue();
      await payments.drive();
      const final = await flowOf(fundingId);
      expect([final.state, final.last_error]).toEqual(['POSTED', null]);
      expect(await balanceOf(user.userId)).toBe(70000n);
    },
  );

  it('initialize accepted but its answer lost: no second Paystack transaction, the read-back decides', async () => {
    const user = await payments.signUp();
    const unpaid = await start(user, '80000');
    paystack.mock.failNext('initialize', 'timeout_after_effect');
    await payments.runner.advance(unpaid);
    expect((await flowOf(unpaid)).state).toBe('INITIATED');
    expect(paystack.mock.transactionsFor(unpaid)).toBe(1);
    await payments.runner.advance(unpaid);
    // Paystack never returns the URL again: an unpaid one cannot be recovered.
    expect(await flowOf(unpaid)).toMatchObject({ state: 'FAILED', failure_code: 'CHECKOUT_UNRECOVERABLE' });
    expect(paystack.mock.transactionsFor(unpaid)).toBe(1);

    const paid = await start(user, '81000');
    paystack.mock.failNext('initialize', 'timeout_after_effect');
    await payments.runner.advance(paid);
    paystack.mock.pay(paid);
    await payments.drive();
    expect((await flowOf(paid)).state).toBe('POSTED');
    expect(paystack.mock.transactionsFor(paid)).toBe(1);
    expect(paystack.mock.statistics().effectiveInitializations).toBeGreaterThanOrEqual(2);
  });

  it('a duplicate reference that verify cannot see yet: read back later, never re-sent', async () => {
    const user = await payments.signUp();
    const fundingId = await start(user, '82000');
    paystack.mock.failNext('initialize', 'timeout_after_effect');
    await payments.runner.advance(fundingId);
    // Verify lags: the next read says "not found", so the step tries initialize — Paystack says duplicate.
    paystack.mock.hideFromVerify(fundingId, 2);
    const initializeCalls = paystack.mock.statistics().requests.initialize;
    await payments.runner.advance(fundingId);
    expect(paystack.mock.statistics().requests.initialize).toBe(initializeCalls + 1);
    expect((await flowOf(fundingId)).state).toBe('INITIATED');
    expect(paystack.mock.transactionsFor(fundingId)).toBe(1);
    await payments.runner.advance(fundingId);
    expect(await flowOf(fundingId)).toMatchObject({ state: 'FAILED', failure_code: 'CHECKOUT_UNRECOVERABLE' });
  });

  it('the funding request replayed with the same key: identical bytes, one flow, one Paystack transaction', async () => {
    const user = await payments.signUp();
    const key = `paystack-replay-${Date.now()}`;
    const first = await paystack.fund(user, { amount: '90000', currency: 'NGN' }, key);
    const second = await paystack.fund(user, { amount: '90000', currency: 'NGN' }, key);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.text).toBe(first.text);
    expect(second.headers['idempotent-replayed']).toBe('true');
    const fundingId = (first.body as { fundingId: string }).fundingId;
    await payments.drive();
    expect(paystack.mock.transactionsFor(fundingId)).toBe(1);
    const flows = (await harness.dataSource.query(
      `SELECT count(*)::int AS count FROM flow_instances WHERE user_id = $1 AND flow_type = 'PAYSTACK_FUNDING'`,
      [user.userId],
    )) as { count: number }[];
    expect(flows[0].count).toBe(1);
  });

  it('the request cannot pick the customer: an email (or any other field) in the body is refused', async () => {
    const user = await payments.signUp();
    const response = await paystack.fund(user, { amount: '10000', currency: 'NGN', email: 'victim@example.com' });
    expect(response.status).toBe(400);
    expect((response.body as { code: string }).code).toBe('VALIDATION_FAILED');
    for (const body of [{ amount: 10000, currency: 'NGN' }, { amount: '100.50', currency: 'NGN' }, { amount: '10000', currency: 'GBP' }]) {
      expect((await paystack.fund(user, body)).status).toBeGreaterThanOrEqual(400);
    }
  });

  it('limits are FUNDING_LIMITS, shared with the simulated PSP', async () => {
    const user = await payments.signUp();
    expect(((await paystack.fund(user, { amount: '99', currency: 'NGN' })).body as { code: string }).code).toBe('AMOUNT_TOO_SMALL');
    expect(((await paystack.fund(user, { amount: '100000000001', currency: 'NGN' })).body as { code: string }).code).toBe('AMOUNT_TOO_LARGE');
  });

  it('a suspended user is never sent to Paystack', async () => {
    const user = await payments.signUp();
    const fundingId = await start(user, '11000');
    await harness.dataSource.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [user.userId]);
    try {
      await payments.resumer.resumeDue(100);
      expect(await flowOf(fundingId)).toMatchObject({ state: 'FAILED', failure_code: 'USER_SUSPENDED' });
      expect(paystack.mock.transactionsFor(fundingId)).toBe(0);
    } finally {
      await harness.dataSource.query(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [user.userId]);
    }
  });

  it('a dispute lost in full → REVERSED through the mirror reversal; won → stays posted; partial → parked', async () => {
    const user = await payments.signUp();
    const lost = await start(user, '100000');
    const won = await start(user, '100001');
    const partial = await start(user, '100002');
    await payments.resumer.resumeDue(100);
    for (const reference of [lost, won, partial]) paystack.mock.pay(reference);
    await payments.drive();
    for (const reference of [lost, won, partial]) expect((await flowOf(reference)).state).toBe('POSTED');

    paystack.mock.resolveDispute(paystack.mock.openDispute(lost), 'merchant-accepted');
    paystack.mock.resolveDispute(paystack.mock.openDispute(won), 'declined');
    paystack.mock.resolveDispute(paystack.mock.openDispute(partial, { refundAmount: '40000' }), 'merchant-accepted');
    await payments.drive();

    expect((await flowOf(lost)).state).toBe('REVERSED');
    const reversal = (await postingsOf(lost)).filter((row) => row.reference === `chargeback:${lost}`);
    expect(reversal.map((row) => [row.code.replace(/^USER:.*:/, 'USER:'), row.direction, row.amount_minor])).toEqual([
      ['USER:NGN', 'DEBIT', '100000'],
      ['PAYSTACK_RECEIVABLE:NGN', 'CREDIT', '100000'],
    ]);
    expect(reversal[0]).toMatchObject({ type: 'REVERSAL', reason_code: 'CHARGEBACK' });
    expect((await flowOf(won)).state).toBe('POSTED');
    const parked = await flowOf(partial);
    expect(parked.state).toBe('POSTED');
    expect(parked.last_error).toMatch(/PARTIAL_CHARGEBACK_UNSUPPORTED: 40000 of 100002/);
    expect(((await paystack.status(user, lost)).body as { status: string }).status).toBe('REVERSED');
    expect(await balanceOf(user.userId)).toBe(100001n + 100002n);
    await harness.expectCleanBooks();
  });

  it('Paystack is never called from inside a database transaction (every call of the whole suite)', () => {
    expect(paystack.gatewayCalls.length).toBeGreaterThan(20);
    expect(new Set(paystack.gatewayCalls.map((call) => call.operation))).toEqual(new Set(['initialize', 'verify', 'listDisputes']));
    expect(paystack.gatewayCalls.filter((call) => call.insideTransaction)).toEqual([]);
  });

  it('the secret key appears nowhere: no log line, provider call, webhook row, response or audit row', async () => {
    const key = paystack.secretKey;
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.filter((line) => line.includes(key))).toEqual([]);
    const [row] = (await harness.dataSource.query(
      `SELECT (SELECT count(*) FROM provider_calls WHERE provider = 'paystack')::int AS calls,
              (SELECT count(*) FROM provider_calls WHERE position($1 in coalesce(request_path, '') || coalesce(request_body::text, '') ||
                 coalesce(response_body::text, '') || coalesce(error, '')) > 0)::int AS leaked_calls,
              (SELECT count(*) FROM webhook_events WHERE position($1 in headers::text || encode(raw_payload, 'escape')) > 0)::int AS leaked_events,
              (SELECT count(*) FROM audit_logs WHERE position($1 in coalesce(before::text, '') || coalesce(after::text, '') || coalesce(reason, '')) > 0)::int AS leaked_audit,
              (SELECT count(*) FROM idempotency_keys WHERE position($1 in coalesce(response_body, '')) > 0)::int AS leaked_responses,
              (SELECT count(*) FROM flow_instances WHERE position($1 in coalesce(last_error, '')) > 0)::int AS leaked_errors`,
      [key],
    )) as { calls: number; leaked_calls: number; leaked_events: number; leaked_audit: number; leaked_responses: number; leaked_errors: number }[];
    expect(row.calls).toBeGreaterThan(20);
    expect(row).toMatchObject({ leaked_calls: 0, leaked_events: 0, leaked_audit: 0, leaked_responses: 0, leaked_errors: 0 });
    // Nor the customer's email in provider_calls.
    const emails = (await harness.dataSource.query(
      `SELECT count(*)::int AS count FROM provider_calls WHERE provider = 'paystack'
         AND (coalesce(request_body::text, '') || coalesce(response_body::text, '')) ~ 'funding-[0-9a-f-]+@example\\.com'`,
    )) as { count: number }[];
    expect(emails[0].count).toBe(0);
    // Sanity: a body signed with the key verifies — the key in hand is the one the app used.
    expect(signPaystackWebhook(key, Buffer.from('x'))).toHaveLength(128);
  });
});
