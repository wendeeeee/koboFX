import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { FlowCheckpoint } from '../../src/modules/flows/flow.types';
import { ReconciliationRunKind } from '../../src/modules/reconciliation/reconciliation-schedule';
import { ProtectedHoldMonitor } from '../../src/modules/withdrawals/protected-hold-monitor';
import { WithdrawalFlow } from '../../src/modules/withdrawals/withdrawal-flow';
import { WithdrawalService } from '../../src/modules/withdrawals/withdrawal.service';
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
const MINUTE = 60_000;

/**
 * W4 races (WITHDRAWAL_PLAN.md §L.2) on real Postgres: the pool is warmed first (pooled connections open lazily, and
 * one connection's authentication outlasts a posting — "parallel" work would silently serialise), and contending
 * commands are issued back to back. After each: no duplicate principal posting, receipt or transfer; no negative or
 * orphan reserve; clean books.
 */
describe('Withdrawal races (W4, integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let paystack: PaystackHarness;
  let withdrawals: WithdrawalsHarness;
  let admin: AdminHarness;
  let administrators: Administrators;
  let checker: SignedUpUser;
  let periodSequence = 0;

  beforeAll(async () => {
    harness = await startLedgerHarness({ RECONCILIATION_UNRESOLVED_FLOW_AGE_MINUTES: '1' }, { fx: true, paystack: { withdrawals: true } });
    payments = harness.payments!;
    paystack = payments.paystack!;
    withdrawals = paystack.withdrawals!;
    admin = payments.admin;
    paystack.mock.transfers.addAccount('058', ACCOUNT_NUMBER, 'ADA LOVELACE');
    paystack.mock.transfers.setBalance(10n ** 15n);
    await harness.fx!.warm();
    administrators = await admin.bootstrap();
    checker = await admin.grant('ADMIN', administrators.admin, administrators.security);
  }, 180_000);
  afterAll(async () => harness?.close());
  beforeEach(async () => {
    paystack.mock.clearFaults();
    paystack.mock.dropWebhooks();
    paystack.mock.transfers.setNextTransfer({ status: 'success', fee: 1_000n, domain: 'test' });
    payments.checkpoints.disarm();
    await payments.clearRateLimits();
    await withdrawals.beat();
    await warmPool();
  });

  const http = () => request(harness.auth!.app.getHttpServer());
  const age = (milliseconds: number) => harness.auth!.clock.advance(milliseconds);
  /** Open every pooled connection at once (each holds a short sleep, so they cannot be reused). */
  const warmPool = () => Promise.all(Array.from({ length: 12 }, () => harness.dataSource.query('SELECT pg_sleep(0.05)')));
  const stateOf = async (flowId: string) =>
    ((await harness.dataSource.query(`SELECT state FROM flow_instances WHERE id = $1`, [flowId])) as { state: string }[])[0].state;
  const count = async (sql: string, parameters: unknown[]) => ((await harness.dataSource.query(sql, parameters)) as { count: number }[])[0].count;
  const principalPostings = (withdrawalId: string) =>
    count(`SELECT count(*)::int AS count FROM transactions WHERE reference = $1`, [`withdrawal:${withdrawalId}`]);
  const receipts = (withdrawalId: string) => count(`SELECT count(*)::int AS count FROM stash_receipts WHERE withdrawal_id = $1`, [withdrawalId]);
  const expectNoNegativeReserves = async () =>
    expect(await count(`SELECT count(*)::int AS count FROM accounts WHERE reserved_minor < 0`, [])).toBe(0);

  const fundedUser = async (amountMinor: bigint): Promise<{ user: SignedUpUser; account: UserAccount }> => {
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
    const beneficiaryId = (accepted.body as { beneficiaryId: string }).beneficiaryId;
    await payments.drive({ deliverWebhooks: false });
    expect((await withdrawals.beneficiary(user, beneficiaryId)).body).toMatchObject({ status: 'READY' });
    return beneficiaryId;
  };
  const pendingWithdrawal = async (amount = '300000') => {
    const { user, account } = await fundedUser(1_000_000n);
    const beneficiaryId = await readyBeneficiary(user);
    paystack.mock.transfers.setNextTransfer({ status: 'pending' });
    const accepted = await withdrawals.withdraw(user, { beneficiaryId, amount, currency: 'NGN' }, randomUUID());
    expect(accepted.status).toBe(202);
    const withdrawalId = (accepted.body as { withdrawalId: string }).withdrawalId;
    await payments.drive({ deliverWebhooks: false });
    expect(await stateOf(withdrawalId)).toBe('PROCESSING');
    return { user, account, withdrawalId, reference: `withdrawal-${withdrawalId}` };
  };
  const hourly = async () => {
    periodSequence += 1;
    return payments.reconciliation.scheduler.runPeriod(ReconciliationRunKind.EXTERNAL_HOURLY, `${3000 + periodSequence}-01-01T00`, 'paystack');
  };

  it('100 distinct withdrawals of ₦800 against ₦1,000 admit exactly one hold; FUNDS_RESERVED while it is held; ₦200 left after success', async () => {
    const { user, account } = await fundedUser(100_000n);
    const beneficiaryId = await readyBeneficiary(user);
    const service = harness.moduleRef.get(WithdrawalService, { strict: false });
    // One emailed code (a user has one open code at a time): at most 5 racers get past the code check (5 tries), one
    // is admitted, and the rest are FUNDS_RESERVED (the gate) or WITHDRAWAL_CODE_INVALID (used/exhausted).
    const oneTimePassword = (await withdrawals.freshCode(user))!;
    // Through the service (the barrier's handler), so HTTP throttling cannot conceal the money race.
    const outcomes = await Promise.all(
      Array.from({ length: 100 }, async () => {
        try {
          await service.request(user.userId, { beneficiaryId, amount: '80000', currency: 'NGN', oneTimePassword });
          return 'ADMITTED';
        } catch (error) {
          return (error as { code?: string }).code ?? String(error);
        }
      }),
    );
    const tally = outcomes.reduce<Record<string, number>>((each, outcome) => ({ ...each, [outcome]: (each[outcome] ?? 0) + 1 }), {});
    expect(tally.ADMITTED).toBe(1);
    expect(Object.keys(tally).every((code) => ['ADMITTED', 'FUNDS_RESERVED', 'WITHDRAWAL_CODE_INVALID', 'RESOURCE_BUSY'].includes(code))).toBe(true);
    expect(await harness.reservedOf(account.accountId)).toBe(80_000n);
    expect(await count(`SELECT count(*)::int AS count FROM reservations WHERE account_id = $1 AND status = 'ACTIVE'`, [account.accountId])).toBe(1);
    expect(await count(`SELECT count(*)::int AS count FROM paystack_withdrawals WHERE user_id = $1`, [user.userId])).toBe(1);
    await payments.drive({ deliverWebhooks: false });
    expect(await harness.balanceOf(account.accountId)).toBe(20_000n);
    expect(await harness.reservedOf(account.accountId)).toBe(0n);
    expect(await count(`SELECT coalesce(sum(amount_minor), 0)::int AS count FROM stash_receipts WHERE user_id = $1`, [user.userId])).toBe(80_000);
    await expectNoNegativeReserves();
    await harness.expectCleanBooks();
  });

  it('one code, two simultaneous withdrawals with funds for both: exactly one is admitted; the other is WITHDRAWAL_CODE_INVALID', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { user, account } = await fundedUser(1_000_000n);
      const beneficiaryId = await readyBeneficiary(user);
      const oneTimePassword = (await withdrawals.freshCode(user))!;
      await warmPool();
      const [first, second] = await Promise.all([
        withdrawals.withdraw(user, { beneficiaryId, amount: '100000', currency: 'NGN', oneTimePassword }, randomUUID()),
        withdrawals.withdraw(user, { beneficiaryId, amount: '200000', currency: 'NGN', oneTimePassword }, randomUUID()),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([202, 400]);
      const refused = [first, second].find((response) => response.status === 400)!;
      expect((refused.body as { code: string }).code).toBe('WITHDRAWAL_CODE_INVALID');
      expect(await count(`SELECT count(*)::int AS count FROM reservations WHERE account_id = $1 AND status = 'ACTIVE'`, [account.accountId])).toBe(1);
      expect(await count(`SELECT count(*)::int AS count FROM paystack_withdrawals WHERE user_id = $1`, [user.userId])).toBe(1);
    }
    await expectNoNegativeReserves();
  });

  it('withdrawal vs conversion on one account: exactly one wins each round; the loser is FUNDS_RESERVED or INSUFFICIENT_FUNDS', async () => {
    for (let round = 0; round < 6; round += 1) {
      const { user, account } = await fundedUser(1_000_000n);
      await harness.openUserAccount('USD', { userId: user.userId, walletId: account.walletId }); // open the target first
      const beneficiaryId = await readyBeneficiary(user);
      await payments.clearRateLimits();
      await warmPool();
      const withdraw = () => withdrawals.withdraw(user, { beneficiaryId, amount: '800000', currency: 'NGN' }, randomUUID());
      const convert = () =>
        http()
          .post(`/${API_PREFIX}/wallet/convert`)
          .set('Authorization', `Bearer ${user.accessToken}`)
          .set('Idempotency-Key', randomUUID())
          .send({ from: 'NGN', to: 'USD', sourceAmount: '800000' });
      // Back to back, alternating who is sent first.
      const [first, second] = round % 2 === 0 ? await Promise.all([withdraw(), convert()]) : await Promise.all([convert(), withdraw()]);
      const responses = [first, second];
      const winners = responses.filter((response) => response.status === 201 || response.status === 202);
      expect(winners).toHaveLength(1);
      const loser = responses.find((response) => response.status !== 201 && response.status !== 202)!;
      expect(['FUNDS_RESERVED', 'INSUFFICIENT_FUNDS']).toContain((loser.body as { code: string }).code);
      await payments.drive({ deliverWebhooks: false });
      expect(await harness.reservedOf(account.accountId)).toBe(0n);
      expect(await harness.balanceOf(account.accountId)).toBe(200_000n);
    }
    await expectNoNegativeReserves();
    await harness.expectCleanBooks();
  });

  it('protected sweeper and monitor vs resolution: the hold is settled once by the flow, never expired or released by either', async () => {
    const { account, withdrawalId, reference } = await pendingWithdrawal();
    paystack.mock.transfers.setTransferStatus(reference, 'success');
    await payments.makeAllDue();
    const monitor = harness.moduleRef.get(ProtectedHoldMonitor, { strict: false });
    const far = new Date(Date.now() + 3650 * 24 * 60 * MINUTE);
    const settled = await Promise.allSettled([
      harness.reservations.expireDue(far, 100),
      payments.runner.advance(withdrawalId),
      monitor.tick(),
      harness.reservations.expireDue(far, 100),
      monitor.tick(),
    ]);
    for (const outcome of settled) if (outcome.status === 'rejected') expect(String(outcome.reason)).not.toMatch(/deadlock/i);
    await payments.drive({ deliverWebhooks: false });
    expect(await stateOf(withdrawalId)).toBe('POSTED');
    const [hold] = (await harness.dataSource.query(
      `SELECT reservations.status::text AS status FROM reservations JOIN paystack_withdrawals ON paystack_withdrawals.reservation_id = reservations.id
        WHERE paystack_withdrawals.flow_id = $1`,
      [withdrawalId],
    )) as { status: string }[];
    expect(hold.status).toBe('SETTLED');
    expect(await principalPostings(withdrawalId)).toBe(1);
    expect(await receipts(withdrawalId)).toBe(1);
    expect(await harness.balanceOf(account.accountId)).toBe(700_000n);
    await expectNoNegativeReserves();
    await harness.expectCleanBooks();
  });

  it('webhook vs resumer vs reconciliation: one completion, one receipt, whoever wins', async () => {
    const { account, withdrawalId, reference } = await pendingWithdrawal();
    age(2 * MINUTE);
    paystack.mock.transfers.setTransferStatus(reference, 'success', { emit: true });
    await paystack.mock.deliverAll(); // the signed hint is stored (202); processing races below
    await payments.makeAllDue();
    await warmPool();
    const outcomes = await Promise.allSettled([
      payments.processor.processDue(100),
      payments.resumer.resumeDue(100),
      hourly(),
      payments.runner.advance(withdrawalId),
    ]);
    for (const outcome of outcomes) if (outcome.status === 'rejected') expect(String(outcome.reason)).not.toMatch(/deadlock|duplicate key/i);
    await payments.makeAllDue();
    await payments.drive();
    expect(await stateOf(withdrawalId)).toBe('POSTED');
    expect(await principalPostings(withdrawalId)).toBe(1);
    expect(await receipts(withdrawalId)).toBe(1);
    expect(paystack.mock.transfers.transfersFor(reference)).toBe(1);
    expect(await harness.balanceOf(account.accountId)).toBe(700_000n);
    await harness.expectCleanBooks();
  });

  it('a stale lease with a delayed write: the paused worker\'s late commit is fenced off — one effect only', async () => {
    const { account, withdrawalId, reference } = await pendingWithdrawal();
    paystack.mock.transfers.setTransferStatus(reference, 'success');
    const paused = payments.checkpoints.arm({ state: 'PROCESSING', point: FlowCheckpoint.AFTER_EXTERNAL_CALL, mode: 'pause' });
    const stale = payments.runner.advance(withdrawalId); // claims the lease, verifies, then pauses OUTSIDE any transaction
    await paused;
    await payments.lapseLeases(); // its lease lapses while it sleeps
    await payments.runner.advance(withdrawalId); // another worker completes it
    expect(await stateOf(withdrawalId)).toBe('POSTED');
    payments.checkpoints.resume();
    await Promise.allSettled([stale]); // its commit must not apply (fenced by the lease token)
    expect(await stateOf(withdrawalId)).toBe('POSTED');
    expect(await principalPostings(withdrawalId)).toBe(1);
    expect(await receipts(withdrawalId)).toBe(1);
    expect(await harness.balanceOf(account.accountId)).toBe(700_000n);
    expect(await harness.reservedOf(account.accountId)).toBe(0n);
    await harness.expectCleanBooks();
  });

  it('approval vs a leased flow: approving while a worker holds the lease is transient (nothing decided); later it refuses ALREADY_RECOVERED', async () => {
    const { account, withdrawalId, reference } = await pendingWithdrawal();
    age(2 * MINUTE);
    await hourly();
    const [notPosted] = (await harness.dataSource.query(
      `SELECT id FROM reconciliation_breaks WHERE type = 'WITHDRAWAL_NOT_POSTED' AND flow_id = $1 AND status <> 'RESOLVED'`,
      [withdrawalId],
    )) as { id: string }[];
    expect(notPosted).toBeDefined();
    paystack.mock.transfers.setTransferStatus(reference, 'success');
    const observed = await harness.moduleRef.get(WithdrawalFlow, { strict: false }).observeForReconciliation(withdrawalId);
    [administrators, checker] = [
      { admin: await payments.logIn(administrators.admin), security: await payments.logIn(administrators.security) },
      await payments.logIn(checker),
    ];
    const requested = await admin.request(administrators.admin, {
      actionType: 'PAYSTACK_WITHDRAWAL_RECOVERY',
      payload: { mode: 'COMPLETE_MATCHED_SUCCESS', withdrawalId, breakId: notPosted.id, observationId: observed!.observationId },
      reason: 'verified success, investigated',
    });
    expect(requested.status).toBe(201);
    const approvalId = (requested.body as { approvalId: string }).approvalId;

    const paused = payments.checkpoints.arm({ state: 'PROCESSING', point: FlowCheckpoint.AFTER_EXTERNAL_CALL, mode: 'pause' });
    const worker = payments.runner.advance(withdrawalId);
    await paused;
    const busy = await admin.decide(checker, approvalId, 'approve');
    expect(busy.status).toBe(503);
    expect((busy.body as { code: string }).code).toBe('RESOURCE_BUSY');
    expect(await count(`SELECT count(*)::int AS count FROM approvals WHERE id = $1 AND status = 'PENDING'`, [approvalId])).toBe(1);

    payments.checkpoints.resume();
    await worker;
    expect(await stateOf(withdrawalId)).toBe('POSTED');
    const late = await admin.decide(checker, approvalId, 'approve');
    expect(late.body).toMatchObject({ status: 'EXECUTION_FAILED', executionFailureCode: 'ALREADY_RECOVERED' });
    expect(await principalPostings(withdrawalId)).toBe(1);
    expect(await receipts(withdrawalId)).toBe(1);
    expect(await harness.balanceOf(account.accountId)).toBe(700_000n);
    await harness.expectCleanBooks();
  });
});
