import { randomUUID } from 'node:crypto';
import { LedgerHarness, PaymentsHarness, PaystackHarness, SignedUpUser, UserAccount, WithdrawalsHarness, startLedgerHarness } from '../support/ledger-harness';

const ACCOUNT_NUMBER = '0123456789';
const ACCOUNT_NAME = 'ADA LOVELACE';

/**
 * W3 — the withdrawal journey end to end (WITHDRAWAL_PLAN.md §E–§G, §J, §K): register → verify → fund → beneficiary
 * READY (Paystack resolves and creates the recipient) → withdraw (202 + protected hold) → the worker sends once, verify
 * confirms, one settlement and one stash receipt. Plus the controls: a webhook is only a hint, a lost send answer
 * yields one transfer, definitive failures release once, a full return reverses exactly, suspension and disablement
 * refuse new work, mismatches hold the money for review. Real HTTP pipeline, real Postgres and Redis, the simulated
 * Paystack over HTTP; worker loops played by the test.
 */
describe('Withdrawal journey (W3, integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let paystack: PaystackHarness;
  let withdrawals: WithdrawalsHarness;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { paystack: { withdrawals: true } });
    payments = harness.payments!;
    paystack = payments.paystack!;
    withdrawals = paystack.withdrawals!;
    paystack.mock.transfers.addAccount('058', ACCOUNT_NUMBER, ACCOUNT_NAME);
    paystack.mock.transfers.setBalance(10n ** 15n);
  });
  afterAll(async () => harness?.close());
  beforeEach(async () => {
    paystack.mock.clearFaults();
    paystack.mock.dropWebhooks();
    paystack.mock.transfers.setNextTransfer({ status: 'success', fee: 1_000n, domain: 'test' });
    await payments.clearRateLimits();
    await withdrawals.beat();
  });

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
    const ready = await withdrawals.beneficiary(user, beneficiaryId);
    expect(ready.body).toMatchObject({ status: 'READY', accountName: ACCOUNT_NAME, accountNumberMasked: '******6789', bankName: 'Guaranty Trust Bank' });
    return beneficiaryId;
  };
  const withdraw = async (user: SignedUpUser, beneficiaryId: string, amount = '300000', key = randomUUID()) => {
    const response = await withdrawals.withdraw(user, { beneficiaryId, amount, currency: 'NGN' }, key);
    return response;
  };
  const stashOf = async (userId: string) =>
    BigInt(
      ((await harness.dataSource.query(
        `SELECT coalesce(sum(CASE event_kind WHEN 'CONFIRMATION' THEN amount_minor ELSE -amount_minor END), 0)::text AS amount FROM stash_receipts WHERE user_id = $1`,
        [userId],
      )) as { amount: string }[])[0].amount,
    );
  const statusOf = async (user: SignedUpUser, withdrawalId: string) => (await withdrawals.withdrawal(user, withdrawalId)).body as Record<string, unknown>;

  it('happy path: 202 + hold → sent once → verified → one settlement, one stash receipt, fee booked as ours', async () => {
    const { user, account } = await fundedUser(1_000_000n);
    const beneficiaryId = await readyBeneficiary(user);
    const accepted = await withdraw(user, beneficiaryId, '300000');
    expect(accepted.status).toBe(202);
    const withdrawalId = (accepted.body as { withdrawalId: string }).withdrawalId;
    expect(accepted.body).toEqual({ withdrawalId, status: 'PENDING', amount: '300000', currency: 'NGN', fee: '0', totalDebit: '300000', provider: 'paystack', simulated: true });
    expect(await harness.reservedOf(account.accountId)).toBe(300_000n);
    expect(await harness.balanceOf(account.accountId)).toBe(1_000_000n);
    expect(paystack.mock.transfers.transfersFor(`withdrawal-${withdrawalId}`)).toBe(0); // the API never called Paystack

    await payments.drive({ deliverWebhooks: false });
    const done = await statusOf(user, withdrawalId);
    expect(done).toMatchObject({
      status: 'COMPLETED',
      amount: '300000',
      fee: '0',
      transactionReference: `withdrawal:${withdrawalId}`,
      destination: { bankCode: '058', accountNumberMasked: '******6789', accountName: ACCOUNT_NAME },
      reviewRequired: false,
    });
    expect(done.stashReceiptId).toEqual(expect.any(String));
    expect(await harness.balanceOf(account.accountId)).toBe(700_000n);
    expect(await harness.reservedOf(account.accountId)).toBe(0n);
    expect(await stashOf(user.userId)).toBe(300_000n);
    expect(paystack.mock.transfers.transfersFor(`withdrawal-${withdrawalId}`)).toBe(1);
    const fees = (await harness.dataSource.query(
      `SELECT amount_minor::text AS amount FROM withdrawal_accounting_events WHERE withdrawal_id = $1 AND event_kind = 'PROVIDER_FEE'`,
      [withdrawalId],
    )) as { amount: string }[];
    expect(fees).toEqual([{ amount: '1000' }]);
    expect(withdrawals.gatewayCalls.some((call) => call.insideTransaction)).toBe(false);
    await harness.expectCleanBooks();
  });

  it('the same key replays the original 202; the same account added again is the same beneficiary', async () => {
    const { user, account } = await fundedUser();
    const beneficiaryId = await readyBeneficiary(user);
    const again = await withdrawals.addBeneficiary(user, { bankCode: '058', accountNumber: ACCOUNT_NUMBER, currency: 'NGN' });
    expect(again.body).toEqual({ beneficiaryId, status: 'READY' });
    const key = randomUUID();
    const first = await withdraw(user, beneficiaryId, '100000', key);
    const replay = await withdraw(user, beneficiaryId, '100000', key);
    expect(replay.status).toBe(202);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(await harness.reservedOf(account.accountId)).toBe(100_000n);
    const reused = await withdraw(user, beneficiaryId, '100001', key);
    expect((reused.body as { code: string }).code).toBe('IDEMPOTENCY_KEY_REUSE');
  });

  it('refuses what it must: funds, limits, a beneficiary not READY or not yours, another currency', async () => {
    const { user } = await fundedUser(50_000n);
    const beneficiaryId = await readyBeneficiary(user);
    expect((await withdraw(user, beneficiaryId, '60000')).body).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect((await withdraw(user, beneficiaryId, '9999')).body).toMatchObject({ code: 'AMOUNT_TOO_SMALL' });
    expect((await withdrawals.withdraw(user, { beneficiaryId, amount: '10000', currency: 'USD' })).body).toMatchObject({ code: 'UNSUPPORTED_CURRENCY' });
    const { user: other } = await fundedUser();
    expect((await withdraw(other, beneficiaryId, '10000')).body).toMatchObject({ code: 'WITHDRAWAL_BENEFICIARY_NOT_FOUND' });
    expect((await withdrawals.withdrawal(other, randomUUID())).body).toMatchObject({ code: 'WITHDRAWAL_NOT_FOUND' });
    paystack.mock.transfers.addAccount('044', '0000000001', 'GRACE HOPPER');
    const pending = await withdrawals.addBeneficiary(user, { bankCode: '044', accountNumber: '0000000001', currency: 'NGN' });
    const pendingId = (pending.body as { beneficiaryId: string }).beneficiaryId;
    expect((await withdraw(user, pendingId, '10000')).body).toMatchObject({ code: 'BENEFICIARY_NOT_READY' });
  });

  it('a signed webhook is only a hint: COMPLETED only once verify says success', async () => {
    const { user, account } = await fundedUser();
    const beneficiaryId = await readyBeneficiary(user);
    paystack.mock.transfers.setNextTransfer({ status: 'pending' });
    const withdrawalId = ((await withdraw(user, beneficiaryId)).body as { withdrawalId: string }).withdrawalId;
    await payments.drive({ deliverWebhooks: false });
    expect(await statusOf(user, withdrawalId)).toMatchObject({ status: 'PENDING' });

    // A genuine, signed transfer.success arrives while verify still says pending: nothing moves.
    const reference = `withdrawal-${withdrawalId}`;
    const hint = Buffer.from(JSON.stringify({ event: 'transfer.success', data: { ...paystack.mock.transfers.transferEventData(reference), status: 'success' } }));
    expect(await paystack.mock.send(hint)).toBe(200);
    await payments.processor.processDue(100);
    expect(await statusOf(user, withdrawalId)).toMatchObject({ status: 'PENDING' });
    expect(await harness.reservedOf(account.accountId)).toBe(300_000n);
    expect(await stashOf(user.userId)).toBe(0n);

    paystack.mock.transfers.setTransferStatus(reference, 'success');
    await payments.makeAllDue(); // processing the hint rescheduled the flow; the resumer verifies again now
    await payments.drive({ deliverWebhooks: false });
    expect(await statusOf(user, withdrawalId)).toMatchObject({ status: 'COMPLETED' });
    expect(await stashOf(user.userId)).toBe(300_000n);
    await harness.expectCleanBooks();
  });

  it('a lost initiate answer: no second transfer, the same reference, completed by verify', async () => {
    const { user } = await fundedUser();
    const beneficiaryId = await readyBeneficiary(user);
    paystack.mock.failNext('transfer_initiate', 'timeout_after_effect');
    const withdrawalId = ((await withdraw(user, beneficiaryId)).body as { withdrawalId: string }).withdrawalId;
    await payments.drive({ deliverWebhooks: false });
    expect(await statusOf(user, withdrawalId)).toMatchObject({ status: 'COMPLETED' });
    expect(paystack.mock.transfers.transfersFor(`withdrawal-${withdrawalId}`)).toBe(1);
    expect(paystack.mock.transfers.effectiveTransfers()).toBeGreaterThan(0);
    await harness.expectCleanBooks();
  });

  it('a verified failure releases the hold once; no posting, no receipt', async () => {
    const { user, account } = await fundedUser();
    const beneficiaryId = await readyBeneficiary(user);
    paystack.mock.transfers.setNextTransfer({ status: 'pending' });
    const withdrawalId = ((await withdraw(user, beneficiaryId)).body as { withdrawalId: string }).withdrawalId;
    await payments.drive({ deliverWebhooks: false });
    paystack.mock.transfers.setTransferStatus(`withdrawal-${withdrawalId}`, 'failed', { emit: true });
    await payments.drive();
    expect(await statusOf(user, withdrawalId)).toMatchObject({ status: 'FAILED', failureCode: 'TRANSFER_FAILED', stashReceiptId: null });
    expect(await harness.reservedOf(account.accountId)).toBe(0n);
    expect(await harness.balanceOf(account.accountId)).toBe(1_000_000n);
    expect(await stashOf(user.userId)).toBe(0n);
    await harness.expectCleanBooks();
  });

  it('a refused FIRST send (insufficient Paystack balance) is definitive: FAILED, hold released', async () => {
    const { user, account } = await fundedUser();
    const beneficiaryId = await readyBeneficiary(user);
    const balance = paystack.mock.transfers.currentBalance();
    paystack.mock.transfers.setBalance(10n);
    try {
      const withdrawalId = ((await withdraw(user, beneficiaryId)).body as { withdrawalId: string }).withdrawalId;
      await payments.drive({ deliverWebhooks: false });
      expect(await statusOf(user, withdrawalId)).toMatchObject({ status: 'FAILED', failureCode: 'PROVIDER_REFUSED_INSUFFICIENT_BALANCE' });
      expect(await harness.reservedOf(account.accountId)).toBe(0n);
    } finally {
      paystack.mock.transfers.setBalance(balance);
    }
    await harness.expectCleanBooks();
  });

  it('a full return after success: principal reversed exactly, provider return booked, reversal receipt, stash back to zero', async () => {
    const { user, account } = await fundedUser();
    const beneficiaryId = await readyBeneficiary(user);
    const withdrawalId = ((await withdraw(user, beneficiaryId)).body as { withdrawalId: string }).withdrawalId;
    await payments.drive({ deliverWebhooks: false });
    expect(await stashOf(user.userId)).toBe(300_000n);

    paystack.mock.transfers.setTransferStatus(`withdrawal-${withdrawalId}`, 'reversed', { emit: true });
    await payments.drive();
    expect(await statusOf(user, withdrawalId)).toMatchObject({ status: 'REVERSED' });
    expect(await harness.balanceOf(account.accountId)).toBe(1_000_000n);
    expect(await stashOf(user.userId)).toBe(0n);
    const receipts = (await harness.dataSource.query(`SELECT event_kind FROM stash_receipts WHERE withdrawal_id = $1 ORDER BY event_kind`, [withdrawalId])) as {
      event_kind: string;
    }[];
    expect(receipts.map((row) => row.event_kind)).toEqual(['CONFIRMATION', 'REVERSAL']);
    await harness.expectCleanBooks();
  });

  it('a suspension that wins the owner lock before the marker cancels the unsent payout', async () => {
    const { user, account } = await fundedUser();
    const beneficiaryId = await readyBeneficiary(user);
    const withdrawalId = ((await withdraw(user, beneficiaryId)).body as { withdrawalId: string }).withdrawalId;
    const owner = await harness.db.ownerClient();
    try {
      await owner.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [user.userId]);
    } finally {
      await owner.end();
    }
    await payments.drive({ deliverWebhooks: false });
    const [row] = (await harness.dataSource.query(`SELECT state, failure_code FROM flow_instances JOIN paystack_withdrawals ON flow_id = id WHERE id = $1`, [withdrawalId])) as {
      state: string;
      failure_code: string;
    }[];
    expect(row).toEqual({ state: 'FAILED', failure_code: 'USER_SUSPENDED' });
    expect(await harness.reservedOf(account.accountId)).toBe(0n);
    expect(paystack.mock.transfers.transfersFor(`withdrawal-${withdrawalId}`)).toBe(0);
  });

  it('a transfer that does not match (another domain) is held for review — never completed, never released', async () => {
    const { user, account } = await fundedUser();
    const beneficiaryId = await readyBeneficiary(user);
    paystack.mock.transfers.setNextTransfer({ domain: 'live' });
    const withdrawalId = ((await withdraw(user, beneficiaryId)).body as { withdrawalId: string }).withdrawalId;
    await payments.drive({ deliverWebhooks: false, rounds: 4 });
    expect(await statusOf(user, withdrawalId)).toMatchObject({ status: 'PENDING', reviewRequired: true });
    expect(await harness.reservedOf(account.accountId)).toBe(300_000n);
    expect(await stashOf(user.userId)).toBe(0n);
  });

  it('with no fresh worker heartbeat, new withdrawals answer 503 WITHDRAWALS_DISABLED (and leave no key behind)', async () => {
    const { user } = await fundedUser();
    const beneficiaryId = await readyBeneficiary(user);
    await harness.dataSource.query(`UPDATE worker_capabilities SET heartbeat_at = now() - interval '1 hour'`);
    const key = randomUUID();
    const refused = await withdraw(user, beneficiaryId, '10000', key);
    expect(refused.status).toBe(503);
    expect((refused.body as { code: string }).code).toBe('WITHDRAWALS_DISABLED');
    await withdrawals.beat();
    expect((await withdraw(user, beneficiaryId, '10000', key)).status).toBe(202);
  });

  it('races: N simultaneous withdrawals against one balance admit exactly one hold', async () => {
    const { user, account } = await fundedUser(100_000n);
    const beneficiaryId = await readyBeneficiary(user);
    await Promise.all(Array.from({ length: 8 }, () => harness.dataSource.query('SELECT 1')));
    const responses = await Promise.all(Array.from({ length: 20 }, () => withdraw(user, beneficiaryId, '80000')));
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 202)).toHaveLength(1);
    for (const response of responses.filter((each) => each.status !== 202)) {
      // Each request fetched its own emailed code; a newer one supersedes it, so WITHDRAWAL_CODE_INVALID is a legitimate refusal too.
      expect(['FUNDS_RESERVED', 'INSUFFICIENT_FUNDS', 'RESOURCE_BUSY', 'WITHDRAWAL_CODE_INVALID']).toContain((response.body as { code: string }).code);
    }
    expect(await harness.reservedOf(account.accountId)).toBe(80_000n);
    await payments.drive({ deliverWebhooks: false });
    expect(await harness.balanceOf(account.accountId)).toBe(20_000n);
    expect(await stashOf(user.userId)).toBe(80_000n);
    await harness.expectCleanBooks();
  });
});

describe('Withdrawals switched off (W3, integration)', () => {
  let harness: LedgerHarness;
  beforeAll(async () => {
    harness = await startLedgerHarness({}, { paystack: true });
  });
  afterAll(async () => harness?.close());

  it('new beneficiaries and withdrawals answer 503 WITHDRAWALS_DISABLED; reads still answer', async () => {
    const payments = harness.payments!;
    const user = await payments.signUp();
    const http = (await import('supertest')).default(harness.auth!.app.getHttpServer());
    const add = await http
      .post('/api/v1/wallet/withdrawal-beneficiaries')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ bankCode: '058', accountNumber: ACCOUNT_NUMBER, currency: 'NGN' });
    expect(add.status).toBe(503);
    expect(add.body.code).toBe('WITHDRAWALS_DISABLED');
    const list = await http.get('/api/v1/wallet/withdrawal-beneficiaries').set('Authorization', `Bearer ${user.accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ items: [], nextCursor: null });
  });
});
