import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { BreakType } from '../../src/modules/reconciliation/break-types';
import { BreakStatus, ResolutionKind } from '../../src/modules/reconciliation/break-transitions';
import { ExternalRunResult } from '../../src/modules/reconciliation/external-reconciliation.job';
import { ReconciliationRunKind } from '../../src/modules/reconciliation/reconciliation-schedule';
import { Administrators, AdminHarness, LedgerHarness, PaymentsHarness, ReconciliationHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/**
 * CORRECTION, end to end (design §5.4, §8.2 "drift is never fixed by overwriting"; Phase 9 decision 3; Phase 10
 * plan §E.4, §F). Each break comes from a real settlement fault on the simulated PSP, is corrected by a request →
 * a DIFFERENT admin's approval → one linked posting through `post()`, and is resolved `CORRECTION_POSTED` citing
 * the approval. After each: CLEARING/receivable/user balances as worked in the plan, the books clean, and the next
 * reconciliation finds nothing new (the receivable proof included).
 */
describe('Admin corrections (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let reconciliation: ReconciliationHarness;
  let admin: AdminHarness;
  let administrators: Administrators;
  let checker: SignedUpUser;
  let user: SignedUpUser;

  const clock = () => harness.auth!.clock;
  const http = () => request(harness.auth!.app.getHttpServer());
  const valueTime = () => new Date(Date.now() - 1000).toISOString();

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { payments: true });
    payments = harness.payments!;
    reconciliation = payments.reconciliation;
    admin = payments.admin;
    harness.auth!.clock.freeze();
    administrators = await admin.bootstrap();
    checker = await admin.grant('ADMIN', administrators.admin, administrators.security);
    user = await payments.signUp();
  }, 180_000);

  afterAll(async () => harness?.close());

  beforeEach(async () => {
    const { psp } = payments;
    psp.setCaptureCompletion('immediate');
    psp.clearFaults();
    await payments.drive();
    clock().advance(3 * DAY);
    psp.settle({ currency: 'NGN' });
    await payments.drive();
    await reconciliation.run(ReconciliationRunKind.EXTERNAL_DAILY);
    await reconciliation.run(ReconciliationRunKind.EXTERNAL_DAILY);
    await payments.clearRateLimits();
    // Tokens outlive nothing on a clock that moves days per test.
    [user, administrators, checker] = [
      await payments.logIn(user),
      { admin: await payments.logIn(administrators.admin), security: await payments.logIn(administrators.security) },
      await payments.logIn(checker),
    ];
  });

  const daily = async () => (await reconciliation.run(ReconciliationRunKind.EXTERNAL_DAILY)) as ExternalRunResult;
  const createdBy = async (result: ExternalRunResult) =>
    (await harness.dataSource.query(`SELECT id, type::text AS type FROM reconciliation_breaks WHERE detected_by_run_id = $1 ORDER BY type`, [
      result.runId,
    ])) as { id: string; type: string }[];
  const systemBalance = async (code: string) =>
    BigInt(
      ((await harness.dataSource.query(`SELECT COALESCE(sum(balance_minor), 0)::text AS balance FROM accounts WHERE code = $1`, [code])) as {
        balance: string;
      }[])[0]!.balance,
    );
  const ngnBalanceOf = async (userId: string) => {
    const [row] = (await harness.dataSource.query(
      `SELECT accounts.balance_minor::text AS balance FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id
        WHERE wallets.user_id = $1 AND accounts.currency_code = 'NGN'`,
      [userId],
    )) as { balance: string }[];
    return BigInt(row?.balance ?? '0');
  };
  async function fund(amount: string): Promise<{ flowId: string; paymentId: string }> {
    const response = await payments.fund(user, { amount, currency: 'NGN', paymentMethodToken: 'tok_success_visa' });
    expect(response.status).toBe(202);
    const flowId = (response.body as { fundingId: string }).fundingId;
    await payments.drive();
    const [row] = (await harness.dataSource.query(`SELECT provider_payment_id FROM funding_payments WHERE flow_id = $1`, [flowId])) as {
      provider_payment_id: string;
    }[];
    return { flowId, paymentId: row!.provider_payment_id };
  }
  const correct = (payload: Record<string, unknown>) =>
    admin.requestAndApprove(administrators.admin, checker, { actionType: 'CORRECTION', payload, reason: 'reconciliation break, investigated' });
  const expectResolvedByApproval = async (breakId: string, approvalId: string) => {
    const found = await reconciliation.breaks.findById(breakId);
    expect(found).toMatchObject({
      status: BreakStatus.RESOLVED,
      resolutionKind: ResolutionKind.CORRECTION_POSTED,
      resolutionReference: `approval:${approvalId}`,
      resolvedBy: `operator:${checker.userId}`,
    });
  };
  const correctionRow = async (approvalId: string) =>
    ((await harness.dataSource.query(
      `SELECT id, type::text AS type, user_id, corrects_transaction_id, correction_subject, initiated_by, reason_code, metadata
         FROM transactions WHERE reference = $1`,
      [`approval:${approvalId}`],
    )) as {
      id: string;
      type: string;
      user_id: string | null;
      corrects_transaction_id: string;
      correction_subject: string | null;
      initiated_by: string;
      reason_code: string;
      metadata: Record<string, unknown>;
    }[])[0]!;

  it('CLEARING → user (a payment we never saw, identified): the user is credited, CLEARING discharged, the break resolved citing the approval', async () => {
    const foreign = payments.psp.createForeignPayment('75000', 'NGN');
    payments.psp.settle({ currency: 'NGN', paymentIds: [foreign] });
    const [broken] = await createdBy(await daily());
    expect(broken!.type).toBe(BreakType.PAYMENT_WITHOUT_FLOW);
    const clearingBefore = await systemBalance('CLEARING:NGN');
    const balanceBefore = await ngnBalanceOf(user.userId);

    const approval = await correct({ mode: 'CLEARING_TO_USER', breakId: broken!.id, userId: user.userId, valueTime: valueTime() });
    expect(approval).toMatchObject({ status: 'EXECUTED', breakId: broken!.id });

    expect(await ngnBalanceOf(user.userId)).toBe(balanceBefore + 75_000n);
    expect((await systemBalance('CLEARING:NGN')) - clearingBefore).toBe(75_000n); // −75,000 → back towards 0
    await expectResolvedByApproval(broken!.id, approval.approvalId as string);
    const row = await correctionRow(approval.approvalId as string);
    expect(row).toMatchObject({
      type: 'CORRECTION',
      user_id: user.userId,
      initiated_by: `operator:${administrators.admin.userId}`,
      reason_code: 'CLEARING_REATTRIBUTION',
      correction_subject: expect.stringMatching(/^line:/),
    });
    expect(row.metadata).toMatchObject({ approvalId: approval.approvalId, breakId: broken!.id, approvedBy: checker.userId });
    expect(approval.resultReference).toBe(row.id);

    // The user's history shows the credit — the corrected settlement only as "internal", never its content.
    const history = await http().get(`/${API_PREFIX}/transactions/approval:${approval.approvalId as string}`).set('Authorization', `Bearer ${user.accessToken}`);
    expect(history.status).toBe(200);
    expect(history.body).toMatchObject({ type: 'CORRECTION', reasonCode: 'CLEARING_REATTRIBUTION', corrects: { internal: true }, initiatedBy: 'OPERATOR' });
    expect(JSON.stringify(history.body)).not.toMatch(/settlement:|CLEARING:|PSP_RECEIVABLE/);
    // The admin history shows every leg and the link.
    const adminView = await admin.get(checker, `users/${user.userId}/transactions/approval:${approval.approvalId as string}`);
    expect(adminView.status).toBe(200);
    expect(adminView.body.legs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: 'CLEARING:NGN', owner: 'INTERNAL', direction: 'DEBIT', amount: '75000' }),
        expect.objectContaining({ owner: 'USER', direction: 'CREDIT', amount: '75000' }),
      ]),
    );
    expect(adminView.body).toMatchObject({ approvalId: approval.approvalId, corrects: { reference: expect.stringMatching(/^settlement:/) } });

    // The same line cannot be corrected twice (refused at request: the break is resolved, the line corrected).
    const again = await admin.request(administrators.admin, {
      actionType: 'CORRECTION',
      payload: { mode: 'CLEARING_TO_USER', breakId: broken!.id, userId: user.userId, valueTime: valueTime() },
      reason: 'again',
    });
    expect(again.status).toBe(409);
    expect(again.body.details.reason).toBe('BREAK_NOT_LIVE');

    clock().advance(2 * HOUR);
    expect((await createdBy(await daily())).map((entry) => entry.type)).not.toContain(BreakType.RECEIVABLE_PROOF_FAILED);
    await harness.expectCleanBooks();
  });

  it('an unknown line refunded: CLEARING → PSP_PAYABLE (we owe it back), no user touched', async () => {
    payments.psp.settle({ currency: 'NGN', paymentIds: [], unknownLines: 1, deductChargebacks: false });
    const [broken] = await createdBy(await daily());
    expect(broken!.type).toBe(BreakType.UNATTRIBUTED_SETTLEMENT_LINE);
    const payableBefore = await systemBalance('PSP_PAYABLE:NGN');
    const clearingBefore = await systemBalance('CLEARING:NGN');
    const approval = await correct({ mode: 'CLEARING_TO_PSP_PAYABLE', breakId: broken!.id, valueTime: valueTime() });
    expect(approval.status).toBe('EXECUTED');
    const lineAmount = (await reconciliation.breaks.findById(broken!.id))!.amountMinor;
    expect((await systemBalance('PSP_PAYABLE:NGN')) - payableBefore).toBe(lineAmount);
    expect((await systemBalance('CLEARING:NGN')) - clearingBefore).toBe(lineAmount);
    expect((await correctionRow(approval.approvalId as string)).user_id).toBeNull();
    await expectResolvedByApproval(broken!.id, approval.approvalId as string);
    await harness.expectCleanBooks();
  });

  it('a duplicated settlement line: CLEARING → PSP_PAYABLE; the first settlement stands', async () => {
    const { paymentId } = await fund('620000');
    const first = payments.psp.settle({ currency: 'NGN', paymentIds: [paymentId] });
    await daily();
    payments.psp.reissue(first);
    const [broken] = await createdBy(await daily());
    expect(broken!.type).toBe(BreakType.DUPLICATE_SETTLEMENT_LINE);
    const approval = await correct({ mode: 'CLEARING_TO_PSP_PAYABLE', breakId: broken!.id, valueTime: valueTime() });
    expect(approval.status).toBe('EXECUTED');
    await expectResolvedByApproval(broken!.id, approval.approvalId as string);
    await harness.expectCleanBooks();
  });

  it('an amount mismatch: the line leaves CLEARING, the deposit is settled from it, the user bears the difference (PSP truth wins)', async () => {
    const { flowId, paymentId } = await fund('500000');
    payments.psp.settle({ currency: 'NGN', paymentIds: [paymentId], alterAmounts: { [paymentId]: -1_000n } });
    const [broken] = await createdBy(await daily());
    expect(broken!.type).toBe(BreakType.AMOUNT_MISMATCH);
    const [receivableBefore, clearingBefore, userBefore] = [
      await systemBalance('PSP_RECEIVABLE:NGN'),
      await systemBalance('CLEARING:NGN'),
      await ngnBalanceOf(user.userId),
    ];

    const approval = await correct({ mode: 'SETTLE_DEPOSIT_FROM_CLEARING', breakId: broken!.id, valueTime: valueTime() });
    expect(approval.status).toBe('EXECUTED');
    expect((await systemBalance('CLEARING:NGN')) - clearingBefore).toBe(499_000n);
    expect((await systemBalance('PSP_RECEIVABLE:NGN')) - receivableBefore).toBe(-500_000n);
    expect((await ngnBalanceOf(user.userId)) - userBefore).toBe(-1_000n);
    const row = await correctionRow(approval.approvalId as string);
    const [deposit] = (await harness.dataSource.query(
      `SELECT funding_transaction_id, settlement_batch_line_id FROM funding_payments WHERE flow_id = $1`,
      [flowId],
    )) as { funding_transaction_id: string; settlement_batch_line_id: string | null }[];
    expect(row.corrects_transaction_id).toBe(deposit!.funding_transaction_id);
    expect(row.correction_subject).toBeNull();
    expect(deposit!.settlement_batch_line_id).not.toBeNull();
    await expectResolvedByApproval(broken!.id, approval.approvalId as string);

    // Never also late, and the receivable proves out.
    clock().advance(6 * DAY);
    const types = (await createdBy(await daily())).map((entry) => entry.type);
    expect(types).not.toContain(BreakType.UNSETTLED_PAST_WINDOW);
    expect(types).not.toContain(BreakType.RECEIVABLE_PROOF_FAILED);
    await harness.expectCleanBooks();
  });

  it('a partial chargeback: the user gives back the disputed part; the flow stops parking it; the later deduction is attributed', async () => {
    const { flowId, paymentId } = await fund('100000');
    payments.psp.settle({ currency: 'NGN', paymentIds: [paymentId] });
    await daily();
    payments.psp.chargeback(paymentId, '30000');
    await payments.drive(); // the flow sees a partial chargeback and parks it
    clock().advance(2 * HOUR);
    [administrators, checker] = [{ ...administrators, admin: await payments.logIn(administrators.admin) }, await payments.logIn(checker)];
    const [broken] = (await createdBy(await daily())).filter((entry) => entry.type === BreakType.CHARGEBACK_NOT_REVERSED);
    expect(broken).toBeDefined();
    expect((await reconciliation.breaks.findById(broken!.id))!.status).toBe(BreakStatus.ESCALATED);
    const userBefore = await ngnBalanceOf(user.userId);
    const receivableBefore = await systemBalance('PSP_RECEIVABLE:NGN');

    const approval = await correct({ mode: 'PARTIAL_CHARGEBACK', breakId: broken!.id, valueTime: valueTime() });
    expect(approval.status).toBe('EXECUTED');
    expect((await ngnBalanceOf(user.userId)) - userBefore).toBe(-30_000n);
    expect((await systemBalance('PSP_RECEIVABLE:NGN')) - receivableBefore).toBe(-30_000n);
    const [deposit] = (await harness.dataSource.query(`SELECT chargeback_transaction_id FROM funding_payments WHERE flow_id = $1`, [flowId])) as {
      chargeback_transaction_id: string | null;
    }[];
    expect(deposit!.chargeback_transaction_id).toBe(approval.resultReference);
    await expectResolvedByApproval(broken!.id, approval.approvalId as string);

    // The flow no longer parks it; the PSP deducts the dispute and the line is ATTRIBUTED (no break, no drift).
    // Driven again (as its hourly re-check would): the chargeback is booked, so the step is IDLE — nothing parked, nothing posted.
    await payments.lapseLeases();
    const transactionsBefore = (await harness.snapshot()).transactionCount;
    const advanced = await payments.runner.advance(flowId, { includeCompleted: true });
    expect(advanced).toMatchObject({ kind: 'RAN', outcomes: [expect.objectContaining({ kind: 'IDLE' })] });
    expect((await harness.snapshot()).transactionCount).toBe(transactionsBefore);
    const deducting = payments.psp.settle({ currency: 'NGN', paymentIds: [] });
    const types = (await createdBy(await daily())).map((entry) => entry.type);
    expect(types).toEqual([]);
    const [line] = (await harness.dataSource.query(
      `SELECT settlement_batch_lines.attribution::text AS attribution FROM settlement_batch_lines
         JOIN settlement_batches ON settlement_batches.id = settlement_batch_lines.batch_id
        WHERE settlement_batches.provider_batch_id = $1 AND settlement_batch_lines.line_type = 'CHARGEBACK'`,
      [deducting],
    )) as { attribution: string }[];
    expect(line?.attribution).toBe('ATTRIBUTED');
    await harness.expectCleanBooks();
  });

  it('a correction of the wrong kind for its break is refused at request, nothing stored', async () => {
    const foreign = payments.psp.createForeignPayment('12000', 'NGN');
    payments.psp.settle({ currency: 'NGN', paymentIds: [foreign] });
    const [broken] = await createdBy(await daily());
    const before = await harness.snapshot();
    const refused = await admin.request(administrators.admin, {
      actionType: 'CORRECTION',
      payload: { mode: 'PARTIAL_CHARGEBACK', breakId: broken!.id, valueTime: valueTime() },
      reason: 'wrong kind',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.details.reason).toBe('BREAK_TYPE_NOT_CORRECTABLE');
    expect((await harness.snapshot()).transactionCount).toBe(before.transactionCount);
  });

  describe('re-validation at execution: the world moved between request and approval', () => {
    it('the break was resolved meanwhile → EXECUTION_FAILED BREAK_NOT_LIVE, recorded and audited; nothing posted', async () => {
      const foreign = payments.psp.createForeignPayment('33000', 'NGN');
      payments.psp.settle({ currency: 'NGN', paymentIds: [foreign] });
      const [broken] = await createdBy(await daily());
      const requested = await admin.request(administrators.admin, {
        actionType: 'CORRECTION',
        payload: { mode: 'CLEARING_TO_USER', breakId: broken!.id, userId: user.userId, valueTime: valueTime() },
        reason: 'identified the payer',
      });
      expect(requested.status).toBe(201);
      // Meanwhile another admin pair closes the break (an operator decision).
      const other = await admin.requestAndApprove(checker, administrators.admin, {
        actionType: 'RESOLVE_BREAK',
        payload: { breakId: broken!.id },
        reason: 'refunded by the PSP out of band',
      });
      expect(other.status).toBe('EXECUTED');
      expect((await reconciliation.breaks.findById(broken!.id))!.resolutionKind).toBe(ResolutionKind.OPERATOR_RESOLVED);

      const before = await harness.snapshot();
      const late = await admin.decide(checker, requested.body.approvalId as string, 'approve');
      expect(late.status).toBe(200);
      expect(late.body).toMatchObject({ status: 'EXECUTION_FAILED', executionFailureCode: 'BREAK_NOT_LIVE', approvedBy: checker.userId });
      const after = await harness.snapshot();
      expect(after.transactionCount).toBe(before.transactionCount);
      expect(after.accountsDigest).toBe(before.accountsDigest);
      const [audited] = (await harness.dataSource.query(
        `SELECT after ->> 'failureCode' AS code FROM audit_logs WHERE subject_id = $1 AND action = 'APPROVAL_EXECUTION_FAILED'`,
        [requested.body.approvalId],
      )) as { code: string }[];
      expect(audited?.code).toBe('BREAK_NOT_LIVE');
    });

    it('the period closed meanwhile → EXECUTION_FAILED PERIOD_LOCKED; never re-dated', async () => {
      const foreign = payments.psp.createForeignPayment('44000', 'NGN');
      payments.psp.settle({ currency: 'NGN', paymentIds: [foreign] });
      const [broken] = await createdBy(await daily());
      const backdated = new Date(Date.UTC(2020, 5, 15)).toISOString(); // June 2020
      const requested = await admin.request(administrators.admin, {
        actionType: 'CORRECTION',
        payload: { mode: 'CLEARING_TO_USER', breakId: broken!.id, userId: user.userId, valueTime: backdated },
        reason: 'attributed to the June report',
      });
      expect(requested.status).toBe(201);
      const owner = await harness.db.ownerClient();
      try {
        await owner.query(`INSERT INTO period_locks (period_start, period_end, locked_by, reason) VALUES ('2020-06-01', '2020-07-01', 'operator:auditor', 'June 2020 reported')`);
      } finally {
        await owner.end();
      }
      const before = await harness.snapshot();
      const late = await admin.decide(checker, requested.body.approvalId as string, 'approve');
      expect(late.body).toMatchObject({ status: 'EXECUTION_FAILED', executionFailureCode: 'PERIOD_LOCKED' });
      expect((await harness.snapshot()).transactionCount).toBe(before.transactionCount);
      expect((await reconciliation.breaks.findById(broken!.id))!.status).toBe(BreakStatus.ESCALATED);
    });
  });
});
