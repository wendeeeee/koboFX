import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { LedgerHarness, PaymentsHarness, PaystackHarness, SignedUpUser, WithdrawalsHarness, startLedgerHarness } from '../support/ledger-harness';

const ACCOUNT_NUMBER = '0123456789';

interface HistoryItem {
  readonly reference: string;
  readonly type: string;
  readonly status: string;
  readonly reasonCode: string | null;
  readonly legs: readonly { currency: string; direction: string; amount: string }[];
  readonly requested: { currency: string; minorUnit: number; amount: string } | null;
  readonly failureCode: string | null;
  readonly corrects: { reference: string; type: string } | null;
  readonly correctedBy: { reference: string; type: string } | null;
}

/**
 * W4 customer reads (WITHDRAWAL_PLAN.md §J): one history item per withdrawal under `withdrawal:{id}` from admission on
 * (PENDING → COMPLETED → REVERSED, or FAILED with no legs), the reversal its own linked item, the WITHDRAWAL filter; and
 * the stash — a balance summed from immutable receipts, a recorded-time keyset, owner-only, never part of the wallet.
 */
describe('Withdrawal history and stash (W4, integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let paystack: PaystackHarness;
  let withdrawals: WithdrawalsHarness;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { paystack: { withdrawals: true } });
    payments = harness.payments!;
    paystack = payments.paystack!;
    withdrawals = paystack.withdrawals!;
    paystack.mock.transfers.addAccount('058', ACCOUNT_NUMBER, 'ADA LOVELACE');
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

  const http = () => request(harness.auth!.app.getHttpServer());
  const get = (user: SignedUpUser, path: string) => http().get(`/${API_PREFIX}${path}`).set('Authorization', `Bearer ${user.accessToken}`);
  const items = async (user: SignedUpUser, query = '') => (await get(user, `/transactions${query}`).expect(200)).body.items as HistoryItem[];

  const fundedUserWithBeneficiary = async () => {
    const user = await payments.signUp();
    const [row] = (await harness.dataSource.query(
      `SELECT accounts.id AS account_id, wallets.id AS wallet_id FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id
        WHERE wallets.user_id = $1 AND accounts.currency_code = 'NGN'`,
      [user.userId],
    )) as { account_id: string; wallet_id: string }[];
    await harness.fund({ userId: user.userId, walletId: row.wallet_id, accountId: row.account_id, currency: 'NGN' }, 1_000_000n);
    const added = await withdrawals.addBeneficiary(user, { bankCode: '058', accountNumber: ACCOUNT_NUMBER, currency: 'NGN' });
    const beneficiaryId = (added.body as { beneficiaryId: string }).beneficiaryId;
    await payments.drive({ deliverWebhooks: false });
    return { user, beneficiaryId };
  };
  const withdraw = async (user: SignedUpUser, beneficiaryId: string, amount: string) => {
    const accepted = await withdrawals.withdraw(user, { beneficiaryId, amount, currency: 'NGN' }, randomUUID());
    expect(accepted.status).toBe(202);
    return (accepted.body as { withdrawalId: string }).withdrawalId;
  };

  it('one item per withdrawal under withdrawal:{id}: PENDING with the requested principal → COMPLETED with the user\'s debit leg → REVERSED + its reversal item', async () => {
    const { user, beneficiaryId } = await fundedUserWithBeneficiary();
    paystack.mock.transfers.setNextTransfer({ status: 'pending' });
    const withdrawalId = await withdraw(user, beneficiaryId, '300000');
    const reference = `withdrawal:${withdrawalId}`;

    const pending = (await items(user, '?type=WITHDRAWAL')).find((item) => item.reference === reference)!;
    expect(pending).toMatchObject({ type: 'WITHDRAWAL', status: 'PENDING', legs: [], requested: { currency: 'NGN', minorUnit: 2, amount: '300000' }, reasonCode: null });
    expect((await get(user, `/transactions/${reference}`).expect(200)).body).toMatchObject({ reference, status: 'PENDING', initiatedBy: 'USER' });

    paystack.mock.transfers.setTransferStatus(`withdrawal-${withdrawalId}`, 'success');
    await payments.makeAllDue();
    await payments.drive({ deliverWebhooks: false });
    const completed = (await items(user)).filter((item) => item.reference === reference);
    expect(completed).toHaveLength(1); // the unposted branch excludes it once posted: never two items
    expect(completed[0]).toMatchObject({
      type: 'WITHDRAWAL',
      status: 'COMPLETED',
      reasonCode: 'PAYSTACK_WITHDRAWAL',
      requested: null,
      legs: [{ currency: 'NGN', direction: 'DEBIT', amount: '300000' }],
    });

    paystack.mock.transfers.setTransferStatus(`withdrawal-${withdrawalId}`, 'reversed', { emit: true });
    await payments.drive();
    const all = await items(user);
    expect(all.find((item) => item.reference === reference)).toMatchObject({
      status: 'REVERSED',
      correctedBy: { reference: `withdrawal-reversal:${withdrawalId}`, type: 'REVERSAL' },
    });
    expect(all.find((item) => item.reference === `withdrawal-reversal:${withdrawalId}`)).toMatchObject({
      type: 'REVERSAL',
      status: 'COMPLETED',
      reasonCode: 'PAYSTACK_TRANSFER_REVERSED',
      legs: [{ currency: 'NGN', direction: 'CREDIT', amount: '300000' }],
      corrects: { reference, type: 'WITHDRAWAL' },
    });
    // Internal legs (payout in transit, payout balance, fees) never appear.
    for (const item of all) for (const leg of item.legs) expect(leg.currency).toBe('NGN');
  });

  it('a withdrawal that FAILED before posting: one FAILED item with its failure code and no legs; the WITHDRAWAL filter and currency filter find it', async () => {
    const { user, beneficiaryId } = await fundedUserWithBeneficiary();
    paystack.mock.transfers.setNextTransfer({ status: 'pending' });
    const withdrawalId = await withdraw(user, beneficiaryId, '150000');
    await payments.drive({ deliverWebhooks: false });
    paystack.mock.transfers.setTransferStatus(`withdrawal-${withdrawalId}`, 'failed');
    await payments.makeAllDue();
    await payments.drive({ deliverWebhooks: false });
    const reference = `withdrawal:${withdrawalId}`;
    for (const query of ['', '?type=WITHDRAWAL', '?currency=NGN', '?type=WITHDRAWAL&currency=NGN&sort=bookingTime']) {
      expect((await items(user, query)).find((item) => item.reference === reference)).toMatchObject({
        status: 'FAILED',
        failureCode: 'TRANSFER_FAILED',
        legs: [],
        requested: { amount: '150000' },
      });
    }
    expect((await items(user, '?type=CONVERSION')).find((item) => item.reference === reference)).toBeUndefined();
    expect((await items(user, '?currency=USD')).find((item) => item.reference === reference)).toBeUndefined();
  });

  it('another user\'s withdrawal reference is the same 404 as an unknown one', async () => {
    const { user, beneficiaryId } = await fundedUserWithBeneficiary();
    const withdrawalId = await withdraw(user, beneficiaryId, '100000');
    const stranger = await payments.signUp();
    for (const reference of [`withdrawal:${withdrawalId}`, `withdrawal:${randomUUID()}`]) {
      expect((await get(stranger, `/transactions/${reference}`).expect(404)).body.code).toBe('TRANSACTION_NOT_FOUND');
    }
  });

  it('the stash: null and "0" before any withdrawal (no write); then confirmations less reversals; receipts newest first, keyset-paginated, owner-only', async () => {
    const { user, beneficiaryId } = await fundedUserWithBeneficiary();
    const [before] = (await harness.dataSource.query(`SELECT count(*)::int AS count FROM customer_stashes WHERE user_id = $1`, [user.userId])) as { count: number }[];
    expect((await get(user, '/stash').expect(200)).body).toEqual({ stashId: null, kind: 'SIMULATED_BANK', simulated: true, balances: [{ currency: 'NGN', minorUnit: 2, amount: '0' }] });
    const [after] = (await harness.dataSource.query(`SELECT count(*)::int AS count FROM customer_stashes WHERE user_id = $1`, [user.userId])) as { count: number }[];
    expect(after.count).toBe(before.count);

    const ids: string[] = [];
    for (const amount of ['100000', '200000', '50000']) {
      ids.push(await withdraw(user, beneficiaryId, amount));
      await payments.drive({ deliverWebhooks: false });
    }
    paystack.mock.transfers.setTransferStatus(`withdrawal-${ids[1]}`, 'reversed', { emit: true });
    await payments.drive();

    const view = (await get(user, '/stash').expect(200)).body;
    expect(view).toMatchObject({ stashId: expect.any(String), kind: 'SIMULATED_BANK', simulated: true, balances: [{ currency: 'NGN', minorUnit: 2, amount: '150000' }] });
    // The stash is not the wallet: the wallet's available is the ledger's alone.
    const wallet = (await get(user, '/wallet').expect(200)).body.balances.find((each: { currency: string }) => each.currency === 'NGN');
    expect(wallet).toMatchObject({ total: '850000', available: '850000' });

    const pages: Record<string, unknown>[][] = [];
    let cursor: string | null = null;
    do {
      const page: { items: Record<string, unknown>[]; nextCursor: string | null } = (await get(user, `/stash/transactions?limit=2${cursor ? `&cursor=${cursor}` : ''}`).expect(200)).body;
      expect(page).toMatchObject({ stashId: view.stashId, kind: 'SIMULATED_BANK', simulated: true });
      pages.push(page.items);
      cursor = page.nextCursor;
    } while (cursor);
    const receipts = pages.flat() as { kind: string; direction: string; amount: string; withdrawalId: string; recordedAt: string; reversesReceiptId: string | null; reversedByReceiptId: string | null; receiptId: string; ledgerReference: string; destination: Record<string, string> }[];
    expect(receipts).toHaveLength(4);
    expect(new Set(receipts.map((each) => each.receiptId)).size).toBe(4);
    const recorded = receipts.map((each) => each.recordedAt);
    expect([...recorded].sort().reverse()).toEqual(recorded);
    const reversal = receipts.find((each) => each.kind === 'REVERSAL')!;
    const reversed = receipts.find((each) => each.kind === 'CONFIRMATION' && each.withdrawalId === ids[1])!;
    expect(reversal).toMatchObject({ direction: 'OUT', amount: '200000', reversesReceiptId: reversed.receiptId, ledgerReference: `withdrawal-reversal:${ids[1]}` });
    expect(reversed).toMatchObject({ direction: 'IN', reversedByReceiptId: reversal.receiptId, ledgerReference: `withdrawal:${ids[1]}` });
    expect(reversed.destination).toEqual({ bankCode: '058', bankName: 'Guaranty Trust Bank', accountNumberMasked: '******6789' });
    expect(JSON.stringify(receipts)).not.toContain(ACCOUNT_NUMBER);

    // Filters and errors.
    expect((await get(user, '/stash/transactions?currency=USD').expect(200)).body.items).toEqual([]);
    expect((await get(user, '/stash/transactions?currency=XYZ').expect(400)).body.code).toBe('UNSUPPORTED_CURRENCY');
    const ngnCursor = (await get(user, '/stash/transactions?currency=NGN&limit=1').expect(200)).body.nextCursor as string;
    expect((await get(user, `/stash/transactions?cursor=${ngnCursor}`).expect(400)).body.code).toBe('INVALID_CURSOR'); // another filter
    expect((await get(user, '/stash/transactions?limit=101').expect(400)).body.code).toBe('VALIDATION_FAILED');

    // Owner-only: another user sees their own empty stash, never this one.
    const stranger = await payments.signUp();
    expect((await get(stranger, '/stash').expect(200)).body).toMatchObject({ stashId: null, balances: [{ currency: 'NGN', amount: '0' }] });
    expect((await get(stranger, '/stash/transactions').expect(200)).body.items).toEqual([]);
  });

  it('reads need an ACTIVE user: unauthenticated 401, suspended 403', async () => {
    const user = await payments.signUp();
    expect((await http().get(`/${API_PREFIX}/stash`)).status).toBe(401);
    const owner = await harness.db.ownerClient();
    try {
      await owner.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [user.userId]);
    } finally {
      await owner.end();
    }
    expect((await get(user, '/stash')).status).toBe(403);
    expect((await get(user, '/stash/transactions')).status).toBe(403);
  });
});
