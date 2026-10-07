import { randomUUID } from 'node:crypto';
import { ProtectedHoldMonitor } from '../../src/modules/withdrawals/protected-hold-monitor';
import { WithdrawalFlow } from '../../src/modules/withdrawals/withdrawal-flow';
import { PaystackTransferReconciliation } from '../../src/modules/reconciliation/paystack/paystack-transfer-reconciliation';
import { ReconciliationRunKind } from '../../src/modules/reconciliation/reconciliation-schedule';
import { BreakStatus, ResolutionKind } from '../../src/modules/reconciliation/break-transitions';
import {
  Administrators,
  AdminHarness,
  LedgerHarness,
  PaymentsHarness,
  PaystackHarness,
  SignedUpUser,
  UserAccount,
  WithdrawalsHarness,
  startLedgerHarness,
} from '../support/ledger-harness';

const ACCOUNT_NUMBER = '0123456789';
const ACCOUNT_NAME = 'ADA LOVELACE';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

interface RunOutcome {
  readonly runId: string;
  readonly status: string;
  readonly detectedBreakIds: readonly string[];
  readonly resolvedBreakIds: readonly string[];
}

interface CreatedBreak {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly flow_id: string | null;
  readonly subject_key: string;
  readonly details: Record<string, unknown>;
}

/**
 * W4 — the TRANSFER family of THE composed Paystack reconciliation, the protected-hold monitor and the four-eyes
 * PAYSTACK_WITHDRAWAL_RECOVERY (WITHDRAWAL_PLAN.md §G.2, §I.2, §I.3, §L W4 row). Real HTTP pipeline, real Postgres and
 * Redis, the simulated Paystack over HTTP; the worker's loops are played by the test. Breaks are asserted on what a run
 * CREATED (`detected_by_run_id`): with withdrawals on, the payout balance is negative (D3), so no run here is CLEAN.
 */
describe('Withdrawal reconciliation, monitor and recovery (W4, integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let paystack: PaystackHarness;
  let withdrawals: WithdrawalsHarness;
  let admin: AdminHarness;
  let administrators: Administrators;
  let checker: SignedUpUser;
  let periodSequence = 0;

  beforeAll(async () => {
    harness = await startLedgerHarness({ RECONCILIATION_UNRESOLVED_FLOW_AGE_MINUTES: '1' }, { paystack: { withdrawals: true } });
    payments = harness.payments!;
    paystack = payments.paystack!;
    withdrawals = paystack.withdrawals!;
    admin = payments.admin;
    paystack.mock.transfers.addAccount('058', ACCOUNT_NUMBER, ACCOUNT_NAME);
    paystack.mock.transfers.setBalance(10n ** 15n);
    administrators = await admin.bootstrap();
    checker = await admin.grant('ADMIN', administrators.admin, administrators.security);
  }, 180_000);
  afterAll(async () => harness?.close());
  beforeEach(async () => {
    paystack.mock.clearFaults();
    paystack.mock.dropWebhooks();
    paystack.mock.transfers.setNextTransfer({ status: 'success', fee: 1_000n, domain: 'test' });
    await payments.clearRateLimits();
    await withdrawals.beat();
    // Tokens outlive nothing on a clock that moves days.
    [administrators, checker] = [
      { admin: await payments.logIn(administrators.admin), security: await payments.logIn(administrators.security) },
      await payments.logIn(checker),
    ];
  });

  /** Time passes (forward only). */
  const age = (milliseconds: number) => harness.auth!.clock.advance(milliseconds);

  async function runPaystack(kind: ReconciliationRunKind): Promise<RunOutcome> {
    periodSequence += 1;
    const key = `${String(3000 + periodSequence)}-01-01${kind === ReconciliationRunKind.EXTERNAL_HOURLY ? 'T00' : ''}`;
    const result = await payments.reconciliation.scheduler.runPeriod(kind, key, 'paystack');
    if (!result) throw new Error('Paystack run not claimed');
    return result as RunOutcome;
  }
  const daily = () => runPaystack(ReconciliationRunKind.EXTERNAL_DAILY);
  const hourly = () => runPaystack(ReconciliationRunKind.EXTERNAL_HOURLY);
  const createdBy = async (runId: string) =>
    (await harness.dataSource.query(
      `SELECT id, type::text AS type, status::text AS status, flow_id, subject_key, details FROM reconciliation_breaks
        WHERE detected_by_run_id = $1 ORDER BY type, id`,
      [runId],
    )) as CreatedBreak[];
  const breakOf = async (breakId: string) => (await payments.reconciliation.breaks.findById(breakId))!;
  const stateOf = async (flowId: string) =>
    ((await harness.dataSource.query(`SELECT state FROM flow_instances WHERE id = $1`, [flowId])) as { state: string }[])[0].state;
  const stashOf = async (userId: string) =>
    BigInt(
      ((await harness.dataSource.query(
        `SELECT coalesce(sum(CASE event_kind WHEN 'CONFIRMATION' THEN amount_minor ELSE -amount_minor END), 0)::text AS amount FROM stash_receipts WHERE user_id = $1`,
        [userId],
      )) as { amount: string }[])[0].amount,
    );
  const receiptsOf = async (withdrawalId: string) =>
    ((await harness.dataSource.query(`SELECT event_kind::text AS kind FROM stash_receipts WHERE withdrawal_id = $1 ORDER BY event_kind`, [withdrawalId])) as {
      kind: string;
    }[]).map((row) => row.kind);

  const fundedUser = async (amountMinor = 1_000_000n): Promise<{ user: SignedUpUser; account: UserAccount }> => {
    const user = await payments.signUp();
    const [row] = (await harness.dataSource.query(
      `SELECT accounts.id AS account_id, wallets.id AS wallet_id FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id
        WHERE wallets.user_id = $1 AND accounts.currency_code = 'NGN'`,
      [user.userId],
    )) as { account_id: string; wallet_id: string }[];
    const account = { userId: user.userId, walletId: row.wallet_id, accountId: row.account_id, currency: 'NGN' };
    await harness.fund(account, amountMinor);
    return { user, account };
  };
  const readyBeneficiary = async (user: SignedUpUser): Promise<string> => {
    const accepted = await withdrawals.addBeneficiary(user, { bankCode: '058', accountNumber: ACCOUNT_NUMBER, currency: 'NGN' });
    expect(accepted.status).toBe(202);
    const beneficiaryId = (accepted.body as { beneficiaryId: string }).beneficiaryId;
    await payments.drive({ deliverWebhooks: false });
    expect((await withdrawals.beneficiary(user, beneficiaryId)).body).toMatchObject({ status: 'READY' });
    return beneficiaryId;
  };
  /** A withdrawal of `amount` that is sent and left at `status` on Paystack (no webhook). */
  const sentWithdrawal = async (status: 'success' | 'pending', amount = '300000') => {
    const { user, account } = await fundedUser();
    const beneficiaryId = await readyBeneficiary(user);
    paystack.mock.transfers.setNextTransfer({ status });
    const accepted = await withdrawals.withdraw(user, { beneficiaryId, amount, currency: 'NGN' }, randomUUID());
    expect(accepted.status).toBe(202);
    const withdrawalId = (accepted.body as { withdrawalId: string }).withdrawalId;
    await payments.drive({ deliverWebhooks: false });
    return { user, account, beneficiaryId, withdrawalId, reference: `withdrawal-${withdrawalId}` };
  };
  /** A withdrawal Paystack definitively failed (verified) and that later succeeded anyway: FAILED locally, success remotely. */
  const lateSuccessWithdrawal = async () => {
    const sent = await sentWithdrawal('pending');
    expect(await stateOf(sent.withdrawalId)).toBe('PROCESSING');
    paystack.mock.transfers.setTransferStatus(sent.reference, 'failed');
    await payments.makeAllDue();
    await payments.drive({ deliverWebhooks: false });
    expect(await stateOf(sent.withdrawalId)).toBe('FAILED');
    expect(await harness.reservedOf(sent.account.accountId)).toBe(0n);
    paystack.mock.transfers.setTransferStatus(sent.reference, 'success');
    age(2 * MINUTE);
    const result = await daily();
    const late = (await createdBy(result.runId)).filter((each) => each.type === 'TRANSFER_WITHOUT_INTENT' && each.flow_id === sent.withdrawalId);
    expect(late).toHaveLength(1);
    expect(late[0].details).toMatchObject({ lateSuccess: true, failedWithdrawalId: sent.withdrawalId, observationId: expect.any(String) });
    return { ...sent, breakId: late[0].id, observationId: late[0].details.observationId as string };
  };
  const recover = (payload: Record<string, unknown>, reason = 'verified late success, investigated') =>
    admin.request(administrators.admin, { actionType: 'PAYSTACK_WITHDRAWAL_RECOVERY', payload, reason });

  describe('the TRANSFER family', () => {
    it('a late reversal OUTSIDE the lookback, with no webhook: the daily run reverses it exactly once', async () => {
      const sent = await sentWithdrawal('success');
      expect(await stateOf(sent.withdrawalId)).toBe('POSTED');
      expect(await stashOf(sent.user.userId)).toBe(300_000n);
      // Far beyond RECONCILIATION_LOOKBACK_DAYS (35): no moving window lists this transfer any more.
      age(40 * DAY);
      paystack.mock.transfers.setTransferStatus(sent.reference, 'reversed'); // no webhook
      const result = await daily();
      expect(await stateOf(sent.withdrawalId)).toBe('REVERSED');
      expect(await harness.balanceOf(sent.account.accountId)).toBe(1_000_000n);
      expect(await stashOf(sent.user.userId)).toBe(0n);
      expect(await receiptsOf(sent.withdrawalId)).toEqual(['CONFIRMATION', 'REVERSAL']);
      // The reversing verify was recorded with the run's provenance.
      const [provenance] = (await harness.dataSource.query(
        `SELECT count(*)::int AS count FROM paystack_transfer_observations
          WHERE withdrawal_id = $1 AND source = 'RECONCILIATION' AND reconciliation_run_id = $2 AND status_classification = 'REVERSED'`,
        [sent.withdrawalId, result.runId],
      )) as { count: number }[];
      expect(provenance.count).toBeGreaterThanOrEqual(1);
      expect((await createdBy(result.runId)).filter((each) => each.type === 'WITHDRAWAL_RETURN_NOT_POSTED')).toEqual([]);
      // Again: nothing more happens (one reversal, ever).
      await daily();
      expect(await receiptsOf(sent.withdrawalId)).toEqual(['CONFIRMATION', 'REVERSAL']);
      expect(await harness.balanceOf(sent.account.accountId)).toBe(1_000_000n);
      await harness.expectCleanBooks();
    });

    it('an unknown successful transfer (another app on the account) escalates as TRANSFER_WITHOUT_INTENT; nobody is debited', async () => {
      const reference = `foreign-${randomUUID()}`;
      const before = await harness.snapshot();
      paystack.mock.transfers.createForeignTransfer({ reference, amount: 77_000n, bankCode: '058', accountNumber: ACCOUNT_NUMBER });
      const result = await daily();
      const unknown = (await createdBy(result.runId)).filter((each) => each.type === 'TRANSFER_WITHOUT_INTENT');
      expect(unknown).toHaveLength(1);
      expect(unknown[0]).toMatchObject({
        status: BreakStatus.ESCALATED,
        flow_id: null,
        subject_key: `transfer:paystack:${paystack.mock.transfers.find(reference)!.id}`,
      });
      expect(unknown[0].details).toMatchObject({ lateSuccess: false, reference, amountMinor: '77000' });
      expect((await harness.snapshot()).transactionCount).toBe(before.transactionCount);
      // Re-detected, never duplicated.
      const again = await daily();
      expect(again.detectedBreakIds).toContain(unknown[0].id);
      expect((await createdBy(again.runId)).filter((each) => each.type === 'TRANSFER_WITHOUT_INTENT')).toEqual([]);
    });

    it('the simulated PSP\'s own run never sweeps a withdrawal break (funding cannot dismiss what it did not look at)', async () => {
      const reference = `foreign-${randomUUID()}`;
      paystack.mock.transfers.createForeignTransfer({ reference, amount: 12_000n, bankCode: '058', accountNumber: ACCOUNT_NUMBER });
      const [unknown] = (await createdBy((await daily()).runId)).filter((each) => each.type === 'TRANSFER_WITHOUT_INTENT');
      const before = await harness.dataSource.query(`SELECT * FROM reconciliation_breaks WHERE id = $1`, [unknown.id]);
      await payments.reconciliation.run(ReconciliationRunKind.EXTERNAL_DAILY);
      // Not escalated, annotated (resolution_note / updated_at) or resolved: the row is untouched.
      expect(await harness.dataSource.query(`SELECT * FROM reconciliation_breaks WHERE id = $1`, [unknown.id])).toEqual(before);
    });

    it('a transfer that disappears from Paystack\'s answers is NOT resolved by its absence (escalated/annotated only)', async () => {
      const reference = `foreign-${randomUUID()}`;
      paystack.mock.transfers.createForeignTransfer({ reference, amount: 13_000n, bankCode: '058', accountNumber: ACCOUNT_NUMBER });
      const [unknown] = (await createdBy((await daily()).runId)).filter((each) => each.type === 'TRANSFER_WITHOUT_INTENT');
      paystack.mock.transfers.setTransferStatus(reference, 'failed'); // no longer a success: no longer detected
      await daily();
      expect((await breakOf(unknown.id)).status).not.toBe(BreakStatus.RESOLVED);
    });

    it('hourly: an unresolved withdrawal past the threshold is WITHDRAWAL_NOT_POSTED; resolved FLOW_ADVANCED once it posts', async () => {
      const sent = await sentWithdrawal('pending');
      age(2 * MINUTE);
      const first = await hourly();
      const [notPosted] = (await createdBy(first.runId)).filter((each) => each.type === 'WITHDRAWAL_NOT_POSTED' && each.flow_id === sent.withdrawalId);
      expect(notPosted).toMatchObject({ status: BreakStatus.OPEN, subject_key: `withdrawal:${sent.withdrawalId}` });
      paystack.mock.transfers.setTransferStatus(sent.reference, 'success');
      // The hourly run drives the flow itself (any age), with its own provenance, then retries the resolution.
      const second = await hourly();
      expect(await stateOf(sent.withdrawalId)).toBe('POSTED');
      expect(second.resolvedBreakIds).toContain(notPosted.id);
      expect(await breakOf(notPosted.id)).toMatchObject({ status: BreakStatus.RESOLVED, resolutionKind: ResolutionKind.FLOW_ADVANCED });
      const [observed] = (await harness.dataSource.query(
        `SELECT count(*)::int AS count FROM paystack_transfer_observations WHERE withdrawal_id = $1 AND source = 'RECONCILIATION' AND reconciliation_run_id = $2`,
        [sent.withdrawalId, second.runId],
      )) as { count: number }[];
      expect(observed.count).toBeGreaterThanOrEqual(1);
      await harness.expectCleanBooks();
    });

    it('no runless breaks: every break names a real, claimed Paystack-or-PSP run', async () => {
      const [row] = (await harness.dataSource.query(
        `SELECT count(*)::int AS count FROM reconciliation_breaks b
          WHERE NOT EXISTS (SELECT 1 FROM reconciliation_runs r WHERE r.id = b.detected_by_run_id)
             OR NOT EXISTS (SELECT 1 FROM reconciliation_runs r WHERE r.id = b.last_detected_run_id)`,
      )) as { count: number }[];
      expect(row.count).toBe(0);
      const [withdrawalBreaks] = (await harness.dataSource.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE r.provider = 'paystack')::int AS paystack
           FROM reconciliation_breaks b JOIN reconciliation_runs r ON r.id = b.detected_by_run_id
          WHERE b.type IN ('TRANSFER_WITHOUT_INTENT', 'TRANSFER_IDENTITY_MISMATCH', 'WITHDRAWAL_NOT_POSTED', 'WITHDRAWAL_RETURN_NOT_POSTED',
                           'WITHDRAWAL_RESERVATION_INCONSISTENT', 'STASH_RECEIPT_INCONSISTENT', 'PAYOUT_BALANCE_PROOF_FAILED',
                           'PAYOUT_FEE_EVIDENCE_MISSING', 'PAYOUT_TREASURY_EVIDENCE_MISSING')`,
      )) as { total: number; paystack: number }[];
      expect(withdrawalBreaks.total).toBeGreaterThan(0);
      expect(withdrawalBreaks.paystack).toBe(withdrawalBreaks.total);
    });
  });

  describe('the protected-hold monitor', () => {
    const monitor = () => harness.moduleRef.get(ProtectedHoldMonitor, { strict: false });
    const holdOf = async (withdrawalId: string) =>
      ((await harness.dataSource.query(
        `SELECT reservations.id, reservations.status::text AS status FROM reservations JOIN paystack_withdrawals ON paystack_withdrawals.reservation_id = reservations.id
          WHERE paystack_withdrawals.flow_id = $1`,
        [withdrawalId],
      )) as { id: string; status: string }[])[0];
    /** A superuser test seam (as for approvals): reservations' expiry is immutable for every role. */
    const ageHold = async (reservationId: string) => {
      const superuser = await harness.db.superuserClient();
      try {
        await superuser.query('BEGIN');
        await superuser.query('ALTER TABLE reservations DISABLE TRIGGER reservations_guard_mutation');
        await superuser.query(`UPDATE reservations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [reservationId]);
        await superuser.query('ALTER TABLE reservations ENABLE TRIGGER reservations_guard_mutation');
        await superuser.query('COMMIT');
      } finally {
        await superuser.end();
      }
    };

    it('an overdue hold: one review, one audit row, one outbox event, once per condition — and the money stays held', async () => {
      const sent = await sentWithdrawal('pending');
      const hold = await holdOf(sent.withdrawalId);
      expect(hold.status).toBe('ACTIVE');
      await ageHold(hold.id);
      const flagged = await monitor().tick();
      expect(flagged).toContainEqual({ reservationId: hold.id, flowId: sent.withdrawalId, condition: 'OVERDUE' });
      // Paged once per (hold, condition).
      expect((await monitor().tick()).filter((each) => each.reservationId === hold.id)).toEqual([]);
      const [audit] = (await harness.dataSource.query(
        `SELECT count(*)::int AS count FROM audit_logs WHERE action = 'PROTECTED_HOLD_FLAGGED' AND subject_id = $1 AND after ->> 'holdCondition' = 'OVERDUE'`,
        [sent.withdrawalId],
      )) as { count: number }[];
      expect(audit.count).toBe(1);
      const [outbox] = (await harness.dataSource.query(
        `SELECT count(*)::int AS count FROM outbox_events WHERE event_type = 'ProtectedHoldFlagged.v1' AND aggregate_id = $1`,
        [sent.withdrawalId],
      )) as { count: number }[];
      expect(outbox.count).toBe(1);
      expect((await withdrawals.withdrawal(await payments.logIn(sent.user), sent.withdrawalId)).body).toMatchObject({ status: 'PENDING', reviewRequired: true });
      // Never released, expired or settled by the monitor — nor by the generic sweeper.
      await harness.reservations.expireDue(new Date(Date.now() + 365 * DAY), 100);
      expect((await holdOf(sent.withdrawalId)).status).toBe('ACTIVE');
      expect(await harness.reservedOf(sent.account.accountId)).toBe(300_000n);
      await harness.auth!.deliverOutbox(); // the acknowledging handler accepts the event
      // The flow still resolves it with evidence.
      paystack.mock.transfers.setTransferStatus(sent.reference, 'success');
      await payments.makeAllDue();
      await payments.drive({ deliverWebhooks: false });
      expect(await stateOf(sent.withdrawalId)).toBe('POSTED');
      expect((await holdOf(sent.withdrawalId)).status).toBe('SETTLED');
      await harness.expectCleanBooks();
    });

    it('a hold nothing will look at soon (NO_RECOVERABLE_SCHEDULE) is paged, not released', async () => {
      const sent = await sentWithdrawal('pending');
      const superuser = await harness.db.superuserClient();
      try {
        await superuser.query(`UPDATE flow_instances SET next_attempt_at = now() + interval '3 hours' WHERE id = $1`, [sent.withdrawalId]);
      } finally {
        await superuser.end();
      }
      const hold = await holdOf(sent.withdrawalId);
      expect(await monitor().tick()).toContainEqual({ reservationId: hold.id, flowId: sent.withdrawalId, condition: 'NO_RECOVERABLE_SCHEDULE' });
      expect((await holdOf(sent.withdrawalId)).status).toBe('ACTIVE');
    });
  });

  describe('PAYSTACK_WITHDRAWAL_RECOVERY through the real approval routes', () => {
    it('a late success on a FAILED withdrawal: refusals first, then one approved recovery — debited once, one receipt, RECOVERY_APPLIED', async () => {
      const late = await lateSuccessWithdrawal();
      const target = { withdrawalId: late.withdrawalId, breakId: late.breakId, observationId: late.observationId };
      const before = await harness.snapshot();

      // Wrong mode for a FAILED withdrawal.
      const wrongMode = await recover({ mode: 'APPLY_MATCHED_FULL_RETURN', ...target });
      expect(wrongMode.status).toBe(409);
      expect(wrongMode.body).toMatchObject({ code: 'ACTION_PRECONDITION_FAILED', details: { reason: 'WRONG_MODE_FOR_STATE' } });

      // Another withdrawal's observation.
      const other = await sentWithdrawal('success', '100000');
      const [foreignObservation] = (await harness.dataSource.query(
        `SELECT id FROM paystack_transfer_observations WHERE withdrawal_id = $1 AND operation = 'transfer.verify' AND status_classification = 'SUCCESS' LIMIT 1`,
        [other.withdrawalId],
      )) as { id: string }[];
      const foreign = await recover({ mode: 'COMPLETE_MATCHED_SUCCESS', ...target, observationId: foreignObservation.id });
      expect(foreign.body).toMatchObject({ code: 'ACTION_PRECONDITION_FAILED', details: { reason: 'OBSERVATION_NOT_OF_WITHDRAWAL' } });

      // Stale evidence: an aged copy of the very observation (superuser seam; the app role cannot backdate evidence).
      const superuser = await harness.db.superuserClient();
      let staleId: string;
      try {
        const columns = ((await superuser.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_name = 'paystack_transfer_observations' AND column_name NOT IN ('id', 'observed_at') ORDER BY ordinal_position`,
        )).rows as { column_name: string }[]).map((row) => row.column_name).join(', ');
        staleId = ((await superuser.query(
          `INSERT INTO paystack_transfer_observations (${columns}, observed_at)
           SELECT ${columns}, date_trunc('milliseconds', now() - interval '25 hours') FROM paystack_transfer_observations WHERE id = $1
           RETURNING id`,
          [late.observationId],
        )).rows as { id: string }[])[0].id;
      } finally {
        await superuser.end();
      }
      const stale = await recover({ mode: 'COMPLETE_MATCHED_SUCCESS', ...target, observationId: staleId });
      expect(stale.body).toMatchObject({ code: 'ACTION_PRECONDITION_FAILED', details: { reason: 'OBSERVATION_STALE' } });

      // A late fact dated inside a locked period: refused, never re-dated.
      const owner = await harness.db.ownerClient();
      try {
        await owner.query(
          `INSERT INTO period_locks (period_start, period_end, locked_by, reason) VALUES ('2020-06-01', '2020-07-01', 'operator:auditor', 'June 2020 reported')`,
        );
      } finally {
        await owner.end();
      }
      const locked = await recover({ mode: 'LATE_FACT_POST', ...target, valueTime: '2020-06-15T00:00:00.000Z' });
      expect(locked.status).toBe(409);
      expect(locked.body).toMatchObject({ code: 'PERIOD_LOCKED' });

      // The refusals changed nothing (but the other withdrawal's own posting).
      expect(await harness.balanceOf(late.account.accountId)).toBe(1_000_000n);
      expect(await receiptsOf(late.withdrawalId)).toEqual([]);

      // The recovery: requested by one admin, approved by ANOTHER, executed in the approver's transaction.
      const approved = await admin.requestAndApprove(administrators.admin, checker, {
        actionType: 'PAYSTACK_WITHDRAWAL_RECOVERY',
        payload: { mode: 'COMPLETE_MATCHED_SUCCESS', ...target },
        reason: 'verified late success, investigated',
      });
      expect(approved).toMatchObject({ status: 'EXECUTED', resultReference: `withdrawal:${late.withdrawalId}` });
      expect(await stateOf(late.withdrawalId)).toBe('POSTED');
      expect(await harness.balanceOf(late.account.accountId)).toBe(700_000n);
      expect(await harness.reservedOf(late.account.accountId)).toBe(0n);
      expect(await receiptsOf(late.withdrawalId)).toEqual(['CONFIRMATION']);
      expect(await stashOf(late.user.userId)).toBe(300_000n);
      expect(await breakOf(late.breakId)).toMatchObject({
        status: BreakStatus.RESOLVED,
        resolutionKind: ResolutionKind.RECOVERY_APPLIED,
        resolutionReference: `approval:${approved.approvalId as string}`,
      });
      const [principal] = (await harness.dataSource.query(
        `SELECT transactions.metadata ->> 'approvalId' AS approval_id, paystack_withdrawals.recovery_approval_id::text AS recovery_approval_id
           FROM paystack_withdrawals JOIN transactions ON transactions.id = paystack_withdrawals.principal_transaction_id WHERE paystack_withdrawals.flow_id = $1`,
        [late.withdrawalId],
      )) as { approval_id: string; recovery_approval_id: string }[];
      expect(principal).toEqual({ approval_id: approved.approvalId, recovery_approval_id: approved.approvalId });
      expect((await withdrawals.withdrawal(await payments.logIn(late.user), late.withdrawalId)).body).toMatchObject({ status: 'COMPLETED' });
      // Never a new transfer: the recovery sends nothing.
      expect(paystack.mock.transfers.transfersFor(late.reference)).toBe(1);
      expect((await harness.snapshot()).transactionCount).toBeGreaterThan(before.transactionCount);

      // A later daily run finds this withdrawal consistent (no new break about it).
      const after = await daily();
      expect((await createdBy(after.runId)).filter((each) => each.flow_id === late.withdrawalId || each.subject_key === `stash-receipt:${late.withdrawalId}`)).toEqual([]);
      await harness.expectCleanBooks();
    });

    it('LATE_FACT_POST in an open period: booked at the approved value time, certificate basis APPROVED_LATE_FACT', async () => {
      const late = await lateSuccessWithdrawal();
      const valueTime = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000).toISOString();
      const approved = await admin.requestAndApprove(administrators.admin, checker, {
        actionType: 'PAYSTACK_WITHDRAWAL_RECOVERY',
        payload: { mode: 'LATE_FACT_POST', withdrawalId: late.withdrawalId, breakId: late.breakId, observationId: late.observationId, valueTime },
        reason: 'late fact booked now',
      });
      expect(approved.status).toBe('EXECUTED');
      const [row] = (await harness.dataSource.query(
        `SELECT transactions.value_time, verifications.value_time_basis::text AS basis, verifications.value_time AS certificate_time
           FROM paystack_withdrawals
           JOIN transactions ON transactions.id = paystack_withdrawals.principal_transaction_id
           JOIN withdrawal_verifications AS verifications ON verifications.id = paystack_withdrawals.confirmation_verification_id
          WHERE paystack_withdrawals.flow_id = $1`,
        [late.withdrawalId],
      )) as { value_time: Date; basis: string; certificate_time: Date }[];
      expect(row.value_time.toISOString()).toBe(valueTime);
      expect(row.certificate_time.toISOString()).toBe(valueTime);
      expect(row.basis).toBe('APPROVED_LATE_FACT');
      expect(await receiptsOf(late.withdrawalId)).toEqual(['CONFIRMATION']);
      await harness.expectCleanBooks();
    });

    it('already recovered normally: approval after the flow posted → EXECUTION_FAILED ALREADY_RECOVERED, no second effect; a new request is refused', async () => {
      const sent = await sentWithdrawal('pending');
      age(2 * MINUTE);
      const [notPosted] = (await createdBy((await hourly()).runId)).filter((each) => each.type === 'WITHDRAWAL_NOT_POSTED' && each.flow_id === sent.withdrawalId);
      paystack.mock.transfers.setTransferStatus(sent.reference, 'success');
      const observed = await harness.moduleRef.get(WithdrawalFlow, { strict: false }).observeForReconciliation(sent.withdrawalId);
      expect(observed).toMatchObject({ matches: true });
      const payload = { mode: 'COMPLETE_MATCHED_SUCCESS', withdrawalId: sent.withdrawalId, breakId: notPosted.id, observationId: observed!.observationId };
      const requested = await recover(payload);
      expect(requested.status).toBe(201);
      // Meanwhile the resumer completes it the normal way.
      await payments.makeAllDue();
      await payments.drive({ deliverWebhooks: false });
      expect(await stateOf(sent.withdrawalId)).toBe('POSTED');
      const before = await harness.snapshot();
      const late = await admin.decide(checker, (requested.body as { approvalId: string }).approvalId, 'approve');
      expect(late.status).toBe(200);
      expect(late.body).toMatchObject({ status: 'EXECUTION_FAILED', executionFailureCode: 'ALREADY_RECOVERED' });
      const after = await harness.snapshot();
      expect(after.transactionCount).toBe(before.transactionCount);
      expect(after.accountsDigest).toBe(before.accountsDigest);
      expect(await harness.balanceOf(sent.account.accountId)).toBe(700_000n);
      expect(await receiptsOf(sent.withdrawalId)).toEqual(['CONFIRMATION']);
      const again = await recover(payload);
      expect(again.body).toMatchObject({ code: 'ACTION_PRECONDITION_FAILED', details: { reason: 'ALREADY_RECOVERED' } });
      await harness.expectCleanBooks();
    });

    it('the action is four-eyes and never break-glass: the requester cannot approve it', async () => {
      const late = await lateSuccessWithdrawal();
      const requested = await recover({ mode: 'COMPLETE_MATCHED_SUCCESS', withdrawalId: late.withdrawalId, breakId: late.breakId, observationId: late.observationId });
      expect(requested.status).toBe(201);
      const self = await admin.decide(administrators.admin, (requested.body as { approvalId: string }).approvalId, 'approve');
      expect(self.status).toBeGreaterThanOrEqual(400);
      expect(await stateOf(late.withdrawalId)).toBe('FAILED');
      const glass = await admin.request(administrators.admin, {
        actionType: 'PAYSTACK_WITHDRAWAL_RECOVERY',
        payload: { mode: 'COMPLETE_MATCHED_SUCCESS', withdrawalId: late.withdrawalId, breakId: late.breakId, observationId: late.observationId },
        reason: 'emergency',
        breakGlass: true,
      });
      expect(glass.status).toBeGreaterThanOrEqual(400);
      expect(await stateOf(late.withdrawalId)).toBe('FAILED');
    });
  });
});

/**
 * The historical census and incomplete scans, on a fresh database: the progress row's origin depends on the earliest
 * payout work, so these run before any withdrawal exists.
 */
describe('Withdrawal reconciliation coverage: census watermark and page caps (W4, integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let paystack: PaystackHarness;
  let periodSequence = 0;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { paystack: { withdrawals: true } });
    payments = harness.payments!;
    paystack = payments.paystack!;
  }, 180_000);
  afterAll(async () => harness?.close());

  const component = () => harness.moduleRef.get(PaystackTransferReconciliation, { strict: false });
  const progress = async () =>
    ((await harness.dataSource.query(
      `SELECT origin, watermark, cycles FROM reconciliation_component_progress WHERE provider = 'paystack' AND component = 'transfer-census'`,
    )) as { origin: Date; watermark: Date; cycles: number }[])[0];
  const nextKey = () => {
    periodSequence += 1;
    return `${String(3000 + periodSequence)}-01-01`;
  };
  const runDaily = (key: string) => payments.reconciliation.scheduler.runPeriod(ReconciliationRunKind.EXTERNAL_DAILY, key, 'paystack');

  it('the historical census advances its watermark 12 windows per run, resumes, and completes cycle after cycle', async () => {
    await runDaily(nextKey());
    const first = await progress();
    // No payout work yet: origin = the moving window's start less a day; one short window covered the whole cycle.
    expect(first.cycles).toBe(1);
    expect(first.watermark.getTime()).toBe(first.origin.getTime());

    harness.auth!.clock.advance(100 * DAY);
    await runDaily(nextKey());
    const second = await progress();
    expect(second.cycles).toBe(1);
    expect(second.watermark.getTime()).toBe(first.origin.getTime() + 12 * 7 * DAY);

    await runDaily(nextKey());
    const third = await progress();
    expect(third.cycles).toBe(2);
    expect(third.watermark.getTime()).toBe(first.origin.getTime());
    expect(third.origin.getTime()).toBe(first.origin.getTime());
  });

  it('a page cap leaves the run unfinished (never CLEAN, never swept, watermark not advanced); the same run resumes and finishes', async () => {
    const transfers = paystack.mock.transfers;
    transfers.addAccount('058', ACCOUNT_NUMBER, ACCOUNT_NAME);
    transfers.setBalance(10n ** 15n);
    for (let index = 0; index < 3; index += 1) {
      transfers.createForeignTransfer({ reference: `foreign-${randomUUID()}`, amount: 10_000n, bankCode: '058', accountNumber: ACCOUNT_NUMBER, status: 'pending' });
    }
    const before = await progress();
    const key = nextKey();
    transfers.setListPageSize(1);
    component().maximumPages = 1;
    try {
      await expect(runDaily(key)).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
      const run = await payments.reconciliation.runs.find(ReconciliationRunKind.EXTERNAL_DAILY, key, 'paystack');
      expect(run).toMatchObject({ status: 'RUNNING' });
      expect(run!.finishedAt ?? null).toBeNull();
      expect((await progress()).watermark.getTime()).toBe(before.watermark.getTime());
    } finally {
      transfers.setListPageSize(undefined);
      component().maximumPages = 1_000;
    }
    const resumed = await runDaily(key);
    expect(resumed).not.toBeNull();
    const finished = await payments.reconciliation.runs.find(ReconciliationRunKind.EXTERNAL_DAILY, key, 'paystack');
    expect(['CLEAN', 'BREAKS_FOUND']).toContain(finished!.status);
  });
});
