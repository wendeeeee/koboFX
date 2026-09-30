import request from 'supertest';
import { PSP_WEBHOOK_PATH } from '../../src/app.setup';
import { BreakType } from '../../src/modules/reconciliation/break-types';
import { BreakStatus, ResolutionKind } from '../../src/modules/reconciliation/break-transitions';
import { ExternalRunResult } from '../../src/modules/reconciliation/external-reconciliation.job';
import { ReconciliationRunStatus } from '../../src/modules/reconciliation/reconciliation-run.repository';
import { ReconciliationRunKind } from '../../src/modules/reconciliation/reconciliation-schedule';
import { LedgerHarness, PaymentsHarness, ReconciliationHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';
import { expectedSettlementDeadline } from '../support/settlement-window-oracle';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/**
 * External reconciliation against the simulated PSP (Phase 9 §6): each scripted fault, injected
 * alone, produces EXACTLY ONE break of the right type — and nothing is posted or edited to make
 * it go away. Resolutions happen only through first-class machinery (drive a flow, reprocess a
 * stored webhook, a late settlement line), and each records its cause.
 *
 * The clock is frozen and moved explicitly (the simulated PSP shares it). Each test starts from a
 * "quiet" state: everything the PSP can still settle is settled and one run absorbs it, so the
 * breaks a test's own runs CREATE are exactly the ones its fault caused.
 */
describe('reconciliation: external faults (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let reconciliation: ReconciliationHarness;
  let user: SignedUpUser;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { payments: true });
    payments = harness.payments!;
    reconciliation = payments.reconciliation;
    harness.auth!.clock.freeze();
    user = await payments.signUp();
  });
  afterAll(async () => harness?.close());

  beforeEach(async () => {
    const { psp } = payments;
    psp.setCaptureCompletion('immediate');
    psp.clearFaults();
    for (const event of psp.pendingWebhooks()) psp.drop(event.id);
    await payments.drive();
    // Quiet: settle whatever is still settleable, then absorb it — T+X later.
    clock().advance(3 * DAY);
    psp.settle({ currency: 'NGN' });
    await payments.drive();
    await reconciliation.run(ReconciliationRunKind.EXTERNAL_DAILY);
    await reconciliation.run(ReconciliationRunKind.EXTERNAL_DAILY);
    await payments.clearRateLimits();
  });

  const clock = () => harness.auth!.clock;
  const http = () => request(harness.auth!.app.getHttpServer());

  async function fund(amount = '150000', token = 'tok_success_visa'): Promise<string> {
    const response = await payments.fund(user, { amount, currency: 'NGN', paymentMethodToken: token });
    if (response.status === 401) {
      // The frozen clock moved past the token's life: log in again.
      const login = await http().post('/api/v1/auth/login').send({ email: user.email, password: 'correct horse battery staple' }).expect(200);
      user = { ...user, accessToken: login.body.tokens.access.token };
      return fund(amount, token);
    }
    expect(response.status).toBe(202);
    return (response.body as { fundingId: string }).fundingId;
  }

  const depositOf = async (flowId: string) =>
    (
      (await harness.dataSource.query(
        `SELECT flow_instances.state, funding_payments.provider_payment_id, funding_payments.amount_minor::text AS amount_minor,
                funding_payments.captured_at, funding_payments.funding_transaction_id, funding_payments.chargeback_transaction_id,
                funding_payments.settlement_batch_line_id
           FROM funding_payments JOIN flow_instances ON flow_instances.id = funding_payments.flow_id
          WHERE funding_payments.flow_id = $1`,
        [flowId],
      )) as {
        state: string;
        provider_payment_id: string;
        amount_minor: string;
        captured_at: Date;
        funding_transaction_id: string | null;
        chargeback_transaction_id: string | null;
        settlement_batch_line_id: string | null;
      }[]
    )[0];

  /** The breaks a run CREATED: `[type, subject, status]`. */
  const createdBy = async (result: ExternalRunResult) =>
    (
      (await harness.dataSource.query(
        `SELECT type::text AS type, subject_key, status::text AS status FROM reconciliation_breaks WHERE detected_by_run_id = $1 ORDER BY type, subject_key`,
        [result.runId],
      )) as { type: string; subject_key: string; status: string }[]
    ).map((row) => [row.type, row.subject_key, row.status]);

  const daily = async () => (await reconciliation.run(ReconciliationRunKind.EXTERNAL_DAILY)) as ExternalRunResult;
  const hourly = async () => (await reconciliation.run(ReconciliationRunKind.EXTERNAL_HOURLY)) as ExternalRunResult;
  const breakOn = async (type: BreakType, subjectKey: string) =>
    (await reconciliation.allBreaks()).filter((entry) => entry.type === type && entry.subjectKey === subjectKey);
  const settlementsOf = async (batchId: string) =>
    (await harness.dataSource.query(`SELECT id FROM transactions WHERE type = 'SETTLEMENT' AND external_reference = $1`, [batchId])) as { id: string }[];
  const userTransactionsDigest = async () =>
    (
      (await harness.dataSource.query(
        `SELECT md5(coalesce(string_agg(id::text || status || coalesce(corrected_by_transaction_id::text, '-'), ',' ORDER BY id), '')) AS digest
           FROM transactions WHERE user_id IS NOT NULL`,
      )) as { digest: string }[]
    )[0].digest;
  const payment = (flowId: string) => async () => (await depositOf(flowId)).provider_payment_id;
  const subject = (paymentId: string) => `payment:simulated-psp:${paymentId}`;

  it('timing: unsettled inside its T+X window is expected (no break); one second past it, exactly one', async () => {
    const flowId = await fund();
    await payments.drive();
    const deposit = await depositOf(flowId);
    // The deadline from an INDEPENDENT oracle (never the code under test): T+2 business days + 24h.
    const deadline = expectedSettlementDeadline(deposit.captured_at, 2, 24).getTime();

    clock().advance(deadline - clock().now().getTime() - 1000); // one second inside
    const inside = await daily();
    expect(await createdBy(inside)).toEqual([]);
    expect(inside.status).toBe(ReconciliationRunStatus.CLEAN);

    clock().advance(2000); // one second past
    const past = await daily();
    expect(await createdBy(past)).toEqual([[BreakType.UNSETTLED_PAST_WINDOW, subject(deposit.provider_payment_id), BreakStatus.OPEN]]);
    expect(past.status).toBe(ReconciliationRunStatus.BREAKS_FOUND);

    // Seen again: the same live break, never a second one.
    const again = await daily();
    expect(await createdBy(again)).toEqual([]);
    expect(await breakOn(BreakType.UNSETTLED_PAST_WINDOW, subject(deposit.provider_payment_id))).toHaveLength(1);
  });

  it('missing line, then a late batch: one UNSETTLED_PAST_WINDOW, resolved SETTLED_LATE by the line that finally settles it', async () => {
    const [kept, omitted] = [await fund('200000'), await fund('300000')];
    await payments.drive();
    const omittedPayment = await payment(omitted)();
    payments.psp.settle({ currency: 'NGN', omit: [omittedPayment] });
    expect(await createdBy(await daily())).toEqual([]);
    expect((await depositOf(kept)).state).toBe('SETTLED');

    clock().advance(5 * DAY);
    const late = await daily();
    expect(await createdBy(late)).toEqual([[BreakType.UNSETTLED_PAST_WINDOW, subject(omittedPayment), BreakStatus.OPEN]]);
    expect((await depositOf(omitted)).state).toBe('POSTED'); // nothing edited to hide it

    const batchId = payments.psp.settle({ currency: 'NGN', paymentIds: [omittedPayment] });
    const settled = await daily();
    expect(await createdBy(settled)).toEqual([]);
    const [resolved] = await breakOn(BreakType.UNSETTLED_PAST_WINDOW, subject(omittedPayment));
    expect(resolved.status).toBe(BreakStatus.RESOLVED);
    expect(resolved.resolutionKind).toBe(ResolutionKind.SETTLED_LATE);
    expect(resolved.resolutionReference).toBe((await depositOf(omitted)).settlement_batch_line_id);
    expect(await settlementsOf(batchId)).toHaveLength(1);
    await harness.expectCleanBooks();
  });

  it('late batch (settled on time, published late): one UNSETTLED_PAST_WINDOW while unseen, resolved when it appears', async () => {
    const flowId = await fund('410000');
    await payments.drive();
    const paymentId = await payment(flowId)();
    const batchId = payments.psp.settle({ currency: 'NGN', paymentIds: [paymentId], settledAt: clock().now(), visibleFrom: new Date(clock().now().getTime() + 10 * DAY) });

    clock().advance(5 * DAY);
    expect(await createdBy(await daily())).toEqual([[BreakType.UNSETTLED_PAST_WINDOW, subject(paymentId), BreakStatus.OPEN]]);

    clock().advance(6 * DAY);
    expect(await createdBy(await daily())).toEqual([]);
    expect((await depositOf(flowId)).state).toBe('SETTLED');
    expect((await breakOn(BreakType.UNSETTLED_PAST_WINDOW, subject(paymentId)))[0].resolutionKind).toBe(ResolutionKind.SETTLED_LATE);
    expect(await settlementsOf(batchId)).toHaveLength(1);
  });

  it('wrong amount: one AMOUNT_MISMATCH, escalated; the line’s money goes to CLEARING; the deposit is untouched and never ALSO late', async () => {
    const flowId = await fund('500000');
    await payments.drive();
    const paymentId = await payment(flowId)();
    const before = await userTransactionsDigest();
    const clearingBefore = (await reconciliation.metrics.clearingBalanceMinor()).find((row) => row.currency === 'NGN')?.balanceMinor ?? 0n;
    const batchId = payments.psp.settle({ currency: 'NGN', paymentIds: [paymentId], alterAmounts: { [paymentId]: -1_000n } });

    const result = await daily();
    expect(await createdBy(result)).toEqual([[BreakType.AMOUNT_MISMATCH, subject(paymentId), BreakStatus.ESCALATED]]);
    expect(await userTransactionsDigest()).toBe(before);
    expect((await depositOf(flowId)).state).toBe('POSTED');
    expect(await settlementsOf(batchId)).toHaveLength(1); // the money really arrived: posted, to CLEARING
    const clearingAfter = (await reconciliation.metrics.clearingBalanceMinor()).find((row) => row.currency === 'NGN')!.balanceMinor;
    // DR BANK / CR CLEARING: the suspense account carries a CREDIT balance — unidentified money we hold.
    expect(clearingAfter - clearingBefore).toBe(-499_000n);

    clock().advance(6 * DAY);
    expect(await createdBy(await daily())).toEqual([]); // owned by the mismatch: not also UNSETTLED_PAST_WINDOW
    await harness.expectCleanBooks();
  });

  it('unknown payment: one UNATTRIBUTED_SETTLEMENT_LINE (the PSP 404s its own line), money to CLEARING', async () => {
    const batchId = payments.psp.settle({ currency: 'NGN', paymentIds: [], unknownLines: 1, deductChargebacks: false });
    const result = await daily();
    const created = await createdBy(result);
    expect(created).toHaveLength(1);
    expect(created[0][0]).toBe(BreakType.UNATTRIBUTED_SETTLEMENT_LINE);
    expect(created[0][2]).toBe(BreakStatus.ESCALATED);
    expect(await settlementsOf(batchId)).toHaveLength(1);
  });

  it('a payment we never saw: one PAYMENT_WITHOUT_FLOW, money to CLEARING', async () => {
    const foreign = payments.psp.createForeignPayment('75000', 'NGN');
    payments.psp.settle({ currency: 'NGN', paymentIds: [foreign] });
    expect(await createdBy(await daily())).toEqual([[BreakType.PAYMENT_WITHOUT_FLOW, subject(foreign), BreakStatus.ESCALATED]]);
    // The completeness check sees the same payment later: the same break, not a second one.
    clock().advance(2 * HOUR);
    expect(await createdBy(await daily())).toEqual([]);
  });

  it('duplicated batch (the same lines re-issued under a new id): one DUPLICATE_SETTLEMENT_LINE; the first settlement stands', async () => {
    const flowId = await fund('620000');
    await payments.drive();
    const paymentId = await payment(flowId)();
    const first = payments.psp.settle({ currency: 'NGN', paymentIds: [paymentId] });
    expect(await createdBy(await daily())).toEqual([]);
    const copy = payments.psp.reissue(first);
    const created = await createdBy(await daily());
    expect(created).toEqual([[BreakType.DUPLICATE_SETTLEMENT_LINE, `line:simulated-psp:${copy}:${copy}_l0001`, BreakStatus.ESCALATED]]);
    expect((await depositOf(flowId)).state).toBe('SETTLED');
    expect(await settlementsOf(first)).toHaveLength(1);
    expect(await settlementsOf(copy)).toHaveLength(1);
    await harness.expectCleanBooks();
  });

  it('the same batch listed and read again: idempotent — no break, no second posting', async () => {
    const flowId = await fund('130000');
    await payments.drive();
    const batchId = payments.psp.settle({ currency: 'NGN', paymentIds: [await payment(flowId)()] });
    expect(await createdBy(await daily())).toEqual([]);
    expect(await createdBy(await daily())).toEqual([]);
    expect(await createdBy(await daily())).toEqual([]);
    expect(await settlementsOf(batchId)).toHaveLength(1);
  });

  it('a report that changed after we read it: one SETTLEMENT_BATCH_CHANGED, a second evidence version, nothing re-posted', async () => {
    const flowId = await fund('140000');
    await payments.drive();
    const batchId = payments.psp.settle({ currency: 'NGN', paymentIds: [await payment(flowId)()] });
    expect(await createdBy(await daily())).toEqual([]);
    payments.psp.revise(batchId, 1n);
    expect(await createdBy(await daily())).toEqual([[BreakType.SETTLEMENT_BATCH_CHANGED, `batch:simulated-psp:${batchId}`, BreakStatus.ESCALATED]]);
    expect(await settlementsOf(batchId)).toHaveLength(1);
    const [{ versions }] = (await harness.dataSource.query(
      `SELECT count(*)::int AS versions FROM settlement_report_versions JOIN settlement_batches ON settlement_batches.id = settlement_report_versions.batch_id
        WHERE settlement_batches.provider_batch_id = $1`,
      [batchId],
    )) as { versions: number }[];
    expect(versions).toBe(2);
  });

  it('the webhook that never arrived: the hourly sweep records MISSING_IN_LEDGER and resolves it by driving the flow', async () => {
    payments.psp.setCaptureCompletion('manual');
    const flowId = await fund('777000');
    await payments.drive(); // authorized, capture requested; the PSP has not captured yet
    const paymentId = await payment(flowId)();
    expect((await depositOf(flowId)).state).toBe('AUTHORIZED');
    payments.psp.completeCapture(paymentId);
    for (const event of payments.psp.pendingWebhooks()) payments.psp.drop(event.id); // the webhook is lost
    // No resumer runs; time passes.
    clock().advance(2 * HOUR);
    const balanceBefore = await harness.balanceOf(
      ((await harness.dataSource.query(`SELECT account_id FROM funding_payments WHERE flow_id = $1`, [flowId])) as { account_id: string }[])[0].account_id,
    );

    const result = await hourly();
    expect(await createdBy(result)).toEqual([[BreakType.MISSING_IN_LEDGER, subject(paymentId), BreakStatus.RESOLVED]]);
    const [found] = await breakOn(BreakType.MISSING_IN_LEDGER, subject(paymentId));
    const deposit = await depositOf(flowId);
    expect(deposit.state).toBe('POSTED');
    expect(found.resolutionKind).toBe(ResolutionKind.FLOW_ADVANCED);
    expect(found.resolutionReference).toBe(deposit.funding_transaction_id);
    expect(found.resolvedBy).toBe('job:reconciliation');
    const accountId = ((await harness.dataSource.query(`SELECT account_id FROM funding_payments WHERE flow_id = $1`, [flowId])) as { account_id: string }[])[0].account_id;
    expect((await harness.balanceOf(accountId)) - balanceBefore).toBe(777_000n);
    const audit = (await harness.dataSource.query(`SELECT action FROM audit_logs WHERE subject_id = $1 ORDER BY occurred_at`, [found.id])) as { action: string }[];
    expect(audit.map((row) => row.action)).toEqual(['RECONCILIATION_BREAK_DETECTED', 'RECONCILIATION_BREAK_RESOLVED']);
  });

  it('a chargeback after settlement whose webhook was lost: CHARGEBACK_NOT_REVERSED, resolved by reversing through the flow (SETTLED → REVERSED)', async () => {
    const flowId = await fund('880000');
    await payments.drive();
    const paymentId = await payment(flowId)();
    payments.psp.settle({ currency: 'NGN', paymentIds: [paymentId] });
    expect(await createdBy(await daily())).toEqual([]);
    expect((await depositOf(flowId)).state).toBe('SETTLED');

    payments.psp.chargeback(paymentId);
    for (const event of payments.psp.pendingWebhooks()) payments.psp.drop(event.id);
    clock().advance(2 * HOUR);
    const result = await daily();
    const created = await createdBy(result);
    expect(created).toEqual([[BreakType.CHARGEBACK_NOT_REVERSED, `flow:${flowId}`, BreakStatus.RESOLVED]]);
    const deposit = await depositOf(flowId);
    expect(deposit.state).toBe('REVERSED');
    const [found] = await breakOn(BreakType.CHARGEBACK_NOT_REVERSED, `flow:${flowId}`);
    expect(found.resolutionKind).toBe(ResolutionKind.REVERSAL_POSTED);
    expect(found.resolutionReference).toBe(deposit.chargeback_transaction_id);

    // The PSP deducts it from its next batch: attributed, and the receivable proof still holds.
    const deduction = payments.psp.settle({ currency: 'NGN', paymentIds: [] });
    expect(await createdBy(await daily())).toEqual([]);
    const [{ attribution }] = (await harness.dataSource.query(
      `SELECT settlement_batch_lines.attribution FROM settlement_batch_lines JOIN settlement_batches ON settlement_batches.id = settlement_batch_lines.batch_id
        WHERE settlement_batches.provider_batch_id = $1 AND settlement_batch_lines.line_type = 'CHARGEBACK'`,
      [deduction],
    )) as { attribution: string }[];
    expect(attribution).toBe('ATTRIBUTED');
    await harness.expectCleanBooks();
  });

  it('a chargeback MONTHS after its payment (far outside the payment lookback), webhook lost: still found and reversed', async () => {
    const flowId = await fund('515000');
    await payments.drive();
    const paymentId = await payment(flowId)();
    payments.psp.settle({ currency: 'NGN', paymentIds: [paymentId] });
    expect(await createdBy(await daily())).toEqual([]);
    clock().advance(90 * DAY); // the payment is now 55 days older than the 35-day lookback
    payments.psp.chargeback(paymentId);
    for (const event of payments.psp.pendingWebhooks()) payments.psp.drop(event.id);
    clock().advance(2 * HOUR);
    expect(await createdBy(await daily())).toEqual([[BreakType.CHARGEBACK_NOT_REVERSED, `flow:${flowId}`, BreakStatus.RESOLVED]]);
    expect((await depositOf(flowId)).state).toBe('REVERSED');
  });

  it('a deposit we booked that the PSP does not have: one MISSING_AT_PSP, escalated', async () => {
    const flowId = await fund('90000');
    await payments.drive();
    const paymentId = await payment(flowId)();
    payments.psp.forget(paymentId);
    const created = await createdBy(await daily());
    expect(created).toEqual([[BreakType.MISSING_AT_PSP, subject(paymentId), BreakStatus.ESCALATED]]);
    expect((await depositOf(flowId)).state).toBe('POSTED');
  });

  it('an UNMATCHED webhook: its stored payload is reprocessed — resolved WEBHOOK_REPROCESSED once a flow matches it', async () => {
    payments.psp.failNext('authorize', 'timeout_after_effect'); // the PSP authorizes; we never hear the answer
    const flowId = await fund('66000');
    await payments.resumer.resumeDue(10);
    const pspPayment = payments.psp.paymentByReference(flowId) as { id: string };
    expect((await depositOf(flowId)).provider_payment_id).toBeNull();
    // A webhook carrying only the payment id (no reference) arrives before we know that id.
    for (const event of payments.psp.pendingWebhooks()) payments.psp.drop(event.id);
    const body = Buffer.from(JSON.stringify({ id: `evt_bare_${flowId.slice(0, 8)}`, type: 'payment.authorized', data: { object: { id: pspPayment.id } } }));
    await http().post(PSP_WEBHOOK_PATH).set({ 'content-type': 'application/json', 'x-psp-signature': payments.psp.sign(body) }).send(body.toString('utf8')).expect(202);
    await payments.processor.processDue(10);
    const [{ outcome, id: webhookEventId }] = (await harness.dataSource.query(
      `SELECT id, outcome FROM webhook_events WHERE provider_event_id = $1`,
      [`evt_bare_${flowId.slice(0, 8)}`],
    )) as { id: string; outcome: string }[];
    expect(outcome).toBe('UNMATCHED');
    await payments.makeAllDue();
    await payments.drive(); // the flow adopts the payment by our reference

    const created = await createdBy(await daily());
    expect(created).toEqual([[BreakType.UNMATCHED_WEBHOOK, `webhook:${webhookEventId}`, BreakStatus.RESOLVED]]);
    const [found] = await breakOn(BreakType.UNMATCHED_WEBHOOK, `webhook:${webhookEventId}`);
    expect(found.resolutionKind).toBe(ResolutionKind.WEBHOOK_REPROCESSED);
    expect(found.resolutionReference).toBe(flowId);
    // Never re-detected after its resolution; the evidence row is unchanged.
    expect(await createdBy(await daily())).toEqual([]);
  });

  it('an UNMATCHED webhook no flow will ever match: detected and escalated with the reason', async () => {
    const foreign = payments.psp.createForeignPayment('12000', 'NGN');
    payments.psp.emitWebhook(foreign, 'payment.captured');
    await payments.psp.deliverAll();
    await payments.processor.processDue(10);
    const created = await createdBy(await daily());
    expect(created.map((row) => row[0])).toEqual([BreakType.UNMATCHED_WEBHOOK]);
    expect(created[0][2]).toBe(BreakStatus.ESCALATED);
  });

  it('a settlement date in a locked period: one SETTLEMENT_IN_LOCKED_PERIOD; nothing posted, never re-dated', async () => {
    const flowId = await fund('55000');
    await payments.drive();
    const settledAt = new Date(clock().now().getTime() - DAY);
    const owner = await harness.db.ownerClient();
    try {
      await owner.query(`INSERT INTO period_locks (period_start, period_end, locked_by, reason) VALUES ($1, $2, 'operator:test', 'closed period')`, [
        new Date(settledAt.getTime() - HOUR),
        new Date(settledAt.getTime() + HOUR),
      ]);
      const batchId = payments.psp.settle({ currency: 'NGN', paymentIds: [await payment(flowId)()], settledAt });
      const created = await createdBy(await daily());
      expect(created).toEqual([[BreakType.SETTLEMENT_IN_LOCKED_PERIOD, `batch:simulated-psp:${batchId}`, BreakStatus.ESCALATED]]);
      expect(await settlementsOf(batchId)).toHaveLength(0);
      const [row] = (await harness.dataSource.query(`SELECT status::text AS status, rejection_code FROM settlement_batches WHERE provider_batch_id = $1`, [batchId])) as {
        status: string;
        rejection_code: string;
      }[];
      expect(row).toEqual({ status: 'REJECTED', rejection_code: 'PERIOD_LOCKED' });
    } finally {
      await owner.end();
    }
  });

  it('a report in a currency we do not hold: one SETTLEMENT_REPORT_REJECTED, the batch kept as evidence, nothing posted (and no stuck run)', async () => {
    const batchId = payments.psp.settle({ currency: 'CHF', paymentIds: [], unknownLines: 1, deductChargebacks: false });
    const result = await daily();
    expect(result.status).toBe('BREAKS_FOUND');
    expect(await createdBy(result)).toEqual([[BreakType.SETTLEMENT_REPORT_REJECTED, `batch:simulated-psp:${batchId}`, BreakStatus.ESCALATED]]);
    const [row] = (await harness.dataSource.query(`SELECT currency_code, status::text AS status, rejection_code FROM settlement_batches WHERE provider_batch_id = $1`, [
      batchId,
    ])) as { currency_code: string; status: string; rejection_code: string }[];
    expect(row).toEqual({ currency_code: 'CHF', status: 'REJECTED', rejection_code: 'UNSUPPORTED_CURRENCY' });
    const [found] = await breakOn(BreakType.SETTLEMENT_REPORT_REJECTED, `batch:simulated-psp:${batchId}`);
    expect(found.currency).toBeNull();
    expect(found.details.reportCurrency).toBe('CHF');
    expect(await settlementsOf(batchId)).toHaveLength(0);
    // The next run finds it unchanged: nothing new, and the run completes.
    expect(await createdBy(await daily())).toEqual([]);
  });

  it('a report whose lines do not add up: one SETTLEMENT_REPORT_REJECTED; nothing posted', async () => {
    const flowId = await fund('44000');
    await payments.drive();
    const batchId = payments.psp.settle({ currency: 'NGN', paymentIds: [await payment(flowId)()], grossDelta: 1n });
    const created = await createdBy(await daily());
    expect(created).toEqual([[BreakType.SETTLEMENT_REPORT_REJECTED, `batch:simulated-psp:${batchId}`, BreakStatus.ESCALATED]]);
    expect(await settlementsOf(batchId)).toHaveLength(0);
    expect((await depositOf(flowId)).state).toBe('POSTED');
    await harness.expectCleanBooks();
  });
});
