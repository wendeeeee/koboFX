import { randomUUID } from 'node:crypto';
import DecimalBase from 'decimal.js';
import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { Money } from '../../src/common/money';
import { EntryDirection, PostingAuthorization, TransactionType } from '../../src/modules/ledger/ledger.types';
import { ReconciliationRunKind } from '../../src/modules/reconciliation/reconciliation-schedule';
import { Administrators, AdminHarness, FxHarness, LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

/** The oracle's own arithmetic: far more digits than any mark needs (never the code under test's configuration). */
const Decimal = DecimalBase.clone({ precision: 80 });

/**
 * The admin read models against the rows (Phase 10 plan §E.9). Oracles are plain SQL and `decimal.js` directly —
 * never the code under test: FX position per currency, its mark to the reference rate, the trial balance; the
 * breaks and runs lists; a user's admin history with every leg — and never another user's data.
 */
describe('Admin reads (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let fx: FxHarness;
  let admin: AdminHarness;
  let first: Administrators;
  let alice: SignedUpUser;
  let bob: SignedUpUser;

  const http = () => request(harness.auth!.app.getHttpServer());
  const credit = async (user: SignedUpUser, amountMinor: bigint) => {
    const [account] = (await harness.dataSource.query(
      `SELECT accounts.id FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id WHERE wallets.user_id = $1 AND accounts.currency_code = 'NGN'`,
      [user.userId],
    )) as { id: string }[];
    await harness.ledger.post({
      transaction: { type: TransactionType.FUNDING, authorization: PostingAuthorization.SYSTEM_DRIVEN, valueTime: new Date(), initiatedBy: 'job:test', userId: user.userId },
      entries: [
        { account: { systemAccount: 'BANK' }, direction: EntryDirection.DEBIT, amount: Money.of(amountMinor, 'NGN') },
        { account: { accountId: account!.id }, direction: EntryDirection.CREDIT, amount: Money.of(amountMinor, 'NGN') },
      ],
    });
  };
  const convert = (user: SignedUpUser, body: Record<string, unknown>) =>
    http().post(`/${API_PREFIX}/wallet/convert`).set('Authorization', `Bearer ${user.accessToken}`).set('Idempotency-Key', randomUUID()).send(body).expect(201);

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { fx: true });
    payments = harness.payments!;
    fx = harness.fx!;
    admin = payments.admin;
    first = await admin.bootstrap();
    await fx.warm();
    [alice, bob] = [await payments.signUp(), await payments.signUp()];
    await credit(alice, 50_000_000n);
    await credit(bob, 30_000_000n);
    await convert(alice, { from: 'NGN', to: 'USD', sourceAmount: '10000000' });
    await convert(alice, { from: 'NGN', to: 'EUR', sourceAmount: '4000000' });
    await convert(bob, { from: 'NGN', to: 'USD', sourceAmount: '7000000' });
    await convert(alice, { from: 'USD', to: 'NGN', sourceAmount: '1500' });
  }, 180_000);

  afterAll(async () => harness?.close());

  beforeEach(async () => payments.clearRateLimits());

  it('positions: FX_POSITION per currency and its mark equal an independent oracle; the trial balance equals the entries', async () => {
    const response = await admin.get(first.admin, 'positions');
    expect(response.status).toBe(200);
    const body = response.body as {
      markedBy: { snapshotId: string; stale: boolean };
      positions: { currency: string; minorUnit: number; position: string; markedUsd: string | null }[];
      totalMarkedUsd: string;
      trialBalance: { currency: string; debits: string; credits: string; balanced: boolean; equationHolds: boolean }[];
    };
    const oracle = (await harness.dataSource.query(
      `SELECT ledger_entries.currency_code AS currency,
              sum(CASE WHEN ledger_entries.direction = 'CREDIT' THEN ledger_entries.amount_minor ELSE -ledger_entries.amount_minor END)::text AS position
         FROM ledger_entries JOIN accounts ON accounts.id = ledger_entries.account_id
        WHERE accounts.code LIKE 'FX_POSITION:%' GROUP BY ledger_entries.currency_code`,
    )) as { currency: string; position: string }[];
    const rates = (await harness.dataSource.query(`SELECT currency_code, rate::text AS rate FROM exchange_rate_snapshot_rates WHERE snapshot_id = $1`, [
      body.markedBy.snapshotId,
    ])) as { currency_code: string; rate: string }[];
    const minorUnits = (await harness.dataSource.query(`SELECT code, minor_unit FROM currencies`)) as { code: string; minor_unit: number }[];
    let exactTotal = new Decimal(0);
    for (const line of body.positions) {
      const expected = oracle.find((row) => row.currency.trim() === line.currency)?.position ?? '0';
      expect({ currency: line.currency, position: line.position }).toEqual({ currency: line.currency, position: expected });
      const rate = new Decimal(rates.find((row) => row.currency_code.trim() === line.currency)!.rate);
      const minorUnit = minorUnits.find((row) => row.code.trim() === line.currency)!.minor_unit;
      const exact = new Decimal(expected).div(new Decimal(10).pow(minorUnit)).div(rate).times(100); // USD has 2
      exactTotal = exactTotal.plus(exact);
      expect(line.markedUsd).toBe(exact.toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toFixed(0));
    }
    expect(body.positions.some((line) => line.position !== '0')).toBe(true);
    expect(body.totalMarkedUsd).toBe(exactTotal.toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toFixed(0));

    const trial = (await harness.dataSource.query(
      `SELECT currency_code AS currency, sum(amount_minor) FILTER (WHERE direction = 'DEBIT')::text AS debits,
              sum(amount_minor) FILTER (WHERE direction = 'CREDIT')::text AS credits
         FROM ledger_entries GROUP BY currency_code ORDER BY currency_code`,
    )) as { currency: string; debits: string; credits: string }[];
    for (const row of trial) {
      expect(body.trialBalance.find((line) => line.currency === row.currency.trim())).toMatchObject({
        debits: row.debits,
        credits: row.credits,
        balanced: true,
        equationHolds: true,
      });
    }
  });

  it('a stale rate still marks the book, flagged', async () => {
    harness.auth!.clock.advance(2 * 86_400_000);
    const response = await admin.get(await payments.logIn(first.admin), 'positions');
    expect(response.body.markedBy).toMatchObject({ stale: true });
    expect(response.body.totalMarkedUsd).not.toBeNull();
    first = { admin: await payments.logIn(first.admin), security: await payments.logIn(first.security) };
    [alice, bob] = [await payments.logIn(alice), await payments.logIn(bob)];
  });

  it('admin history: the same user\'s rows as their own history, with every leg (internal accounts) — and never another user\'s', async () => {
    const response = await admin.get(first.admin, `users/${alice.userId}/transactions?limit=100`);
    expect(response.status).toBe(200);
    const items = response.body.items as { reference: string; legs: { accountCode: string; owner: string }[]; metadata: Record<string, unknown>; initiatedByIdentity: string }[];
    const own = (await harness.dataSource.query(`SELECT reference FROM transactions WHERE user_id = $1`, [alice.userId])) as { reference: string }[];
    expect(items.map((item) => item.reference).sort()).toEqual(own.map((row) => row.reference).sort());
    const conversion = items.find((item) => item.reference.startsWith('conversion:'))!;
    expect(conversion.legs.map((leg) => leg.accountCode)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^FX_POSITION:/), expect.stringMatching(/^REVENUE:FX_SPREAD:/)]),
    );
    expect(conversion.legs.every((leg) => leg.owner === 'USER' || leg.owner === 'INTERNAL')).toBe(true);
    expect(conversion.initiatedByIdentity).toBe(`user:${alice.userId}`);
    expect(JSON.stringify(response.body)).not.toContain(bob.userId);
    expect(JSON.stringify(response.body)).not.toMatch(/@example\.com/);

    // The user's own history shows none of that.
    const mine = await http().get(`/${API_PREFIX}/transactions/${conversion.reference}`).set('Authorization', `Bearer ${alice.accessToken}`);
    expect(JSON.stringify(mine.body)).not.toMatch(/FX_POSITION|REVENUE|metadata/);

    // Bob's transaction under Alice's id: not found (scoped by the user in SQL).
    const [bobs] = (await harness.dataSource.query(`SELECT reference FROM transactions WHERE user_id = $1 LIMIT 1`, [bob.userId])) as { reference: string }[];
    expect((await admin.get(first.admin, `users/${alice.userId}/transactions/${bobs!.reference}`)).status).toBe(404);
    expect((await admin.get(first.admin, `users/${randomUUID()}/transactions`)).body.code).toBe('USER_NOT_FOUND');
    expect((await admin.get(first.admin, `users/${alice.userId}`)).body).toEqual({
      userId: alice.userId,
      status: 'ACTIVE',
      role: 'USER',
      createdAt: expect.any(String),
      verifiedAt: expect.any(String),
    });
  });

  it('breaks and runs: filtered, keyset-paginated, with evidence, findings and the approvals that named them', async () => {
    const foreign = payments.psp.createForeignPayment('20000', 'NGN');
    const second = payments.psp.createForeignPayment('30000', 'NGN');
    payments.psp.settle({ currency: 'NGN', paymentIds: [foreign, second] });
    await payments.reconciliation.run(ReconciliationRunKind.EXTERNAL_DAILY);
    await payments.reconciliation.run(ReconciliationRunKind.INTERNAL);

    const page = await admin.get(first.admin, 'breaks?status=LIVE&severity=MONEY&limit=1');
    expect(page.status).toBe(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.items[0]).toMatchObject({ severity: 'MONEY', type: 'PAYMENT_WITHOUT_FLOW' });
    const next = await admin.get(first.admin, `breaks?status=LIVE&severity=MONEY&limit=1&cursor=${page.body.nextCursor as string}`);
    expect(next.body.items).toHaveLength(1);
    expect(next.body.items[0].breakId).not.toBe(page.body.items[0].breakId);
    expect((await admin.get(first.admin, `breaks?status=RESOLVED&cursor=${page.body.nextCursor as string}`)).body.code).toBe('INVALID_CURSOR');

    const breakId = page.body.items[0].breakId as string;
    await admin.request(first.admin, { actionType: 'RESOLVE_BREAK', payload: { breakId }, reason: 'refunded out of band' });
    const detail = await admin.get(first.admin, `breaks/${breakId}`);
    expect(detail.body).toMatchObject({ breakId, evidence: { settlementBatchLineId: expect.any(String) } });
    expect(detail.body.approvals).toEqual([expect.objectContaining({ actionType: 'RESOLVE_BREAK', status: 'PENDING' })]);
    expect(detail.body.trail.map((entry: { action: string }) => entry.action)).toContain('RECONCILIATION_BREAK_DETECTED');

    const runs = await admin.get(first.admin, 'reconciliation-runs?kind=INTERNAL&limit=5');
    expect(runs.status).toBe(200);
    const runId = runs.body.items[0].runId as string;
    const run = await admin.get(first.admin, `reconciliation-runs/${runId}`);
    expect(run.body).toMatchObject({ runId, kind: 'INTERNAL', findings: expect.any(Array) });
    expect((await admin.get(first.admin, `reconciliation-runs/${randomUUID()}`)).body.code).toBe('RECONCILIATION_RUN_NOT_FOUND');
  });
});
