import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { RECORDED_RATES } from '../../src/mock-exchange-rate-api/mock-exchange-rate-api';
import { Money } from '../../src/common/money';
import { RateTier } from '../../src/modules/fx/freshness';
import { EntryDirection, PostingAuthorization, TransactionType } from '../../src/modules/ledger/ledger.types';
import { ReconciliationRunKind } from '../../src/modules/reconciliation/reconciliation-schedule';
import { Administrators, AdminHarness, FxHarness, LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

/**
 * Every non-correction action end to end — request → a different admin's approval → execution → its effect
 * (Phase 10 plan §E.5–§E.10): rate override (un-halt; manual rate with its validity and provenance), spread change,
 * write-off (and the world moving before approval), suspension and reinstatement, and closing a period.
 * The FX clock is frozen and moved explicitly; admins log in again whenever it passes their token's life.
 */
describe('Admin actions (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let fx: FxHarness;
  let admin: AdminHarness;
  let administrators: Administrators;
  let checker: SignedUpUser;

  const clock = () => harness.auth!.clock;
  const http = () => request(harness.auth!.app.getHttpServer());
  const refreshLogins = async () => {
    administrators = { admin: await payments.logIn(administrators.admin), security: await payments.logIn(administrators.security) };
    checker = await payments.logIn(checker);
  };
  const approve = (body: Record<string, unknown>) => admin.requestAndApprove(administrators.admin, checker, body);
  const ngnAccountOf = async (userId: string) =>
    ((await harness.dataSource.query(
      `SELECT accounts.id, accounts.balance_minor::text AS balance FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id
        WHERE wallets.user_id = $1 AND accounts.currency_code = 'NGN'`,
      [userId],
    )) as { id: string; balance: string }[])[0]!;
  const latestFetch = async () =>
    ((await harness.dataSource.query(
      `SELECT id, status::text AS status FROM exchange_rate_snapshots WHERE provider = 'exchange-rate-api' AND origin = 'PROVIDER'
        ORDER BY fetched_at DESC, id DESC LIMIT 1`,
    )) as { id: string; status: string }[])[0]!;
  const post = (accountId: string, userId: string, direction: EntryDirection, amountMinor: bigint) =>
    harness.ledger.post({
      transaction: { type: TransactionType.WITHDRAWAL, authorization: PostingAuthorization.SYSTEM_DRIVEN, valueTime: new Date(), initiatedBy: 'job:test', userId },
      entries: [
        { account: { accountId }, direction, amount: Money.of(amountMinor, 'NGN') },
        {
          account: { systemAccount: 'BANK' },
          direction: direction === EntryDirection.DEBIT ? EntryDirection.CREDIT : EntryDirection.DEBIT,
          amount: Money.of(amountMinor, 'NGN'),
        },
      ],
    });

  /** The recorded rates of the ACTIVE currencies only: a manual rate names exactly those. */
  const activeRates = async (): Promise<Record<string, string>> => {
    const rows = (await harness.dataSource.query(`SELECT code FROM currencies WHERE is_active ORDER BY code`)) as { code: string }[];
    return Object.fromEntries(rows.map((row) => [row.code.trim(), RECORDED_RATES[row.code.trim()] as string]));
  };

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { fx: true });
    payments = harness.payments!;
    fx = harness.fx!;
    admin = payments.admin;
    administrators = await admin.bootstrap();
    checker = await admin.grant('ADMIN', administrators.admin, administrators.security);
  }, 180_000);

  afterAll(async () => harness?.close());

  beforeEach(async () => {
    await payments.clearRateLimits();
  });

  describe('RATE_OVERRIDE', () => {
    it('accepting a halted (> 20% jump) fetch un-halts the feed: served now, and the next fetch is judged against it', async () => {
      await fx.warm();
      const before = (await fx.rates.current())!.snapshot.id;
      clock().advance(400_000);
      await refreshLogins();
      fx.publishFresh({ ...RECORDED_RATES, NGN: '1700' });
      expect(await fx.poller.tick()).toMatchObject({ outcome: { kind: 'REJECTED', reasons: ['RATE_JUMP:NGN'] } });
      const rejected = await latestFetch();
      expect(rejected.status).toBe('REJECTED');
      expect((await fx.rates.current())!.snapshot.id).toBe(before); // halted: the old rate keeps ageing

      const approval = await approve({ actionType: 'RATE_OVERRIDE', payload: { mode: 'ACCEPT_REJECTED_SNAPSHOT', snapshotId: rejected.id }, reason: 'NGN devaluation confirmed' });
      expect(approval.status).toBe('EXECUTED');
      const overrideId = approval.resultReference as string;
      const [copy] = (await harness.dataSource.query(
        `SELECT origin::text AS origin, overrides_snapshot_id::text AS overrides, approval_id::text AS approval FROM exchange_rate_snapshots WHERE id = $1`,
        [overrideId],
      )) as { origin: string; overrides: string; approval: string }[];
      expect(copy).toEqual({ origin: 'OVERRIDE', overrides: rejected.id, approval: approval.approvalId });

      await harness.auth!.deliverOutbox(); // the worker offers it to Redis
      fx.rates.forgetLocalCopy();
      const served = (await fx.rates.current())!;
      expect(served.snapshot.id).toBe(overrideId);
      expect(served.snapshot.rates.get('NGN')!.toFixed()).toBe('1700');
      expect(served.freshness.tier).toBe(RateTier.EXECUTABLE);

      // Un-halted: the next publication near 1700 is accepted.
      clock().advance(400_000);
      fx.publishFresh({ ...RECORDED_RATES, NGN: '1712' });
      expect(await fx.poller.tick()).toMatchObject({ outcome: { kind: 'ACCEPTED' } });
    });

    it('refuses to override anything but the latest fetch rejected by the jump rule alone', async () => {
      await refreshLogins();
      const accepted = await latestFetch();
      const refused = await admin.request(administrators.admin, { actionType: 'RATE_OVERRIDE', payload: { mode: 'ACCEPT_REJECTED_SNAPSHOT', snapshotId: accepted.id }, reason: 'x' });
      expect(refused.status).toBe(409);
      expect(refused.body.details.reason).toBe('SNAPSHOT_NOT_REJECTED');
      clock().advance(400_000);
      await refreshLogins();
      fx.publishFresh({ ...RECORDED_RATES, NGN: '0' });
      expect(await fx.poller.tick()).toMatchObject({ outcome: { kind: 'REJECTED' } });
      const broken = await latestFetch();
      const notJump = await admin.request(administrators.admin, { actionType: 'RATE_OVERRIDE', payload: { mode: 'ACCEPT_REJECTED_SNAPSHOT', snapshotId: broken.id }, reason: 'x' });
      expect(notJump.body.details.reason).toBe('SNAPSHOT_NOT_OVERRIDABLE');
    });

    it('a manual rate (all providers down, cache cold): executable for its approved window only, `manual` in the trade provenance', async () => {
      clock().advance(3 * 86_400_000); // everything we hold is now unservable
      await refreshLogins();
      fx.api.failNext({ kind: 'server-error' }, { kind: 'server-error' }, { kind: 'server-error' });
      await fx.resetRedisState();
      expect((await fx.rates.current())?.freshness.tier).toBe(RateTier.UNSERVABLE);

      const tooLong = await admin.request(administrators.admin, { actionType: 'RATE_OVERRIDE', payload: { mode: 'MANUAL_RATE', rates: await activeRates(), validForSeconds: 7_200 }, reason: 'x' });
      expect(tooLong.body.details.reason).toBe('MANUAL_RATE_VALIDITY_TOO_LONG');
      const missing = await admin.request(administrators.admin, { actionType: 'RATE_OVERRIDE', payload: { mode: 'MANUAL_RATE', rates: { USD: '1', NGN: '1500' }, validForSeconds: 600 }, reason: 'x' });
      expect(missing.body.details.reason).toBe('MANUAL_RATE_INCOMPLETE');

      const approval = await approve({ actionType: 'RATE_OVERRIDE', payload: { mode: 'MANUAL_RATE', rates: await activeRates(), validForSeconds: 600 }, reason: 'provider outage, treasury desk rate' });
      expect(approval.status).toBe('EXECUTED');
      await harness.auth!.deliverOutbox();
      fx.rates.forgetLocalCopy();
      const served = (await fx.rates.current())!;
      expect(served.snapshot).toMatchObject({ id: approval.resultReference, provider: 'manual' });
      expect(served.freshness.tier).toBe(RateTier.EXECUTABLE);

      const trader = await payments.signUp();
      const account = await ngnAccountOf(trader.userId);
      await post(account.id, trader.userId, EntryDirection.CREDIT, 5_000_000n);
      const converted = await http()
        .post(`/${API_PREFIX}/wallet/convert`)
        .set('Authorization', `Bearer ${trader.accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ from: 'NGN', to: 'USD', sourceAmount: '1000000' });
      expect(converted.status).toBe(201);
      const [provenance] = (await harness.dataSource.query(`SELECT rate_provider, rate_snapshot_id::text AS snapshot FROM transactions WHERE id = $1`, [
        converted.body.transactionId,
      ])) as { rate_provider: string; snapshot: string }[];
      expect(provenance).toEqual({ rate_provider: 'manual', snapshot: approval.resultReference });

      clock().advance(601_000); // past the approved validity: no grace for a manual rate
      fx.rates.forgetLocalCopy();
      expect((await fx.rates.current())!.freshness.tier).not.toBe(RateTier.EXECUTABLE);
    });
  });

  it('SPREAD_CHANGE: the pair changes only through its approval; the audit row holds before and after', async () => {
    await refreshLogins();
    const approval = await approve({
      actionType: 'SPREAD_CHANGE',
      payload: { sourceCurrency: 'NGN', targetCurrency: 'USD', spreadBasisPoints: 75, minimumSourceAmount: '200000' },
      reason: 'competitive pricing review Q4',
    });
    expect(approval).toMatchObject({ status: 'EXECUTED', resultReference: 'NGN/USD' });
    const [pair] = (await harness.dataSource.query(
      `SELECT spread_basis_points, minimum_source_amount_minor::text AS minimum FROM currency_pairs WHERE source_currency_code = 'NGN' AND target_currency_code = 'USD'`,
    )) as { spread_basis_points: number; minimum: string }[];
    expect(pair).toEqual({ spread_basis_points: 75, minimum: '200000' });
    const [audited] = (await harness.dataSource.query(`SELECT before, after FROM audit_logs WHERE subject_id = $1 AND action = 'CURRENCY_PAIR_CHANGED'`, [
      approval.approvalId,
    ])) as { before: Record<string, unknown>; after: Record<string, unknown> }[];
    expect(audited).toEqual({
      before: { currencyPair: 'NGN/USD', spreadBasisPoints: 150, minimumSourceAmountMinor: '100000' },
      after: { currencyPair: 'NGN/USD', spreadBasisPoints: 75, minimumSourceAmountMinor: '200000' },
    });
  });

  it('WRITE_OFF: only an overdraft, never more than it; a deposit landing before approval refuses a write-off that no longer fits', async () => {
    await refreshLogins();
    const debtor = await payments.signUp();
    const account = await ngnAccountOf(debtor.userId);
    const writeOff = (amount: string) => ({ actionType: 'WRITE_OFF', payload: { userId: debtor.userId, currency: 'NGN', amount, valueTime: new Date(Date.now() - 1000).toISOString() }, reason: 'unrecoverable after collections' });

    expect((await admin.request(administrators.admin, writeOff('100'))).body.details.reason).toBe('ACCOUNT_NOT_OVERDRAWN');
    await post(account.id, debtor.userId, EntryDirection.DEBIT, 50_000n); // a chargeback after the money was spent
    expect((await admin.request(administrators.admin, writeOff('60000'))).body.details.reason).toBe('WRITE_OFF_EXCEEDS_OVERDRAFT');

    const partial = await approve(writeOff('20000'));
    expect(partial.status).toBe('EXECUTED');
    expect((await ngnAccountOf(debtor.userId)).balance).toBe('-30000');

    const requested = await admin.request(administrators.admin, writeOff('30000'));
    expect(requested.status).toBe(201);
    await post(account.id, debtor.userId, EntryDirection.CREDIT, 10_000n); // the user paid some back meanwhile
    const late = await admin.decide(checker, requested.body.approvalId as string, 'approve');
    expect(late.body).toMatchObject({ status: 'EXECUTION_FAILED', executionFailureCode: 'WRITE_OFF_EXCEEDS_OVERDRAFT' });

    const rest = await approve(writeOff('20000'));
    expect(rest.status).toBe('EXECUTED');
    expect((await ngnAccountOf(debtor.userId)).balance).toBe('0');
    const [row] = (await harness.dataSource.query(`SELECT type::text AS type, reason_code FROM transactions WHERE reference = $1`, [`approval:${rest.approvalId as string}`])) as {
      type: string;
      reason_code: string;
    }[];
    expect(row).toEqual({ type: 'WRITE_OFF', reason_code: 'WRITE_OFF' });
    await harness.expectCleanBooks();
  });

  it('SUSPEND then REINSTATE: out on the next request and unable to log in; back in after reinstatement (a fresh login)', async () => {
    await refreshLogins();
    const target = await payments.signUp();
    expect((await approve({ actionType: 'SUSPEND_USER', payload: { userId: target.userId }, reason: 'fraud investigation' })).status).toBe('EXECUTED');
    expect((await http().get(`/${API_PREFIX}/wallet`).set('Authorization', `Bearer ${target.accessToken}`)).status).toBe(401);
    await expect(payments.logIn(target)).rejects.toThrow(/401/);
    const again = await admin.request(administrators.admin, { actionType: 'SUSPEND_USER', payload: { userId: target.userId }, reason: 'x' });
    expect(again.body.details.reason).toBe('USER_STATUS_CHANGED');
    expect((await approve({ actionType: 'REINSTATE_USER', payload: { userId: target.userId }, reason: 'cleared' })).status).toBe('EXECUTED');
    const back = await payments.logIn(target);
    expect((await http().get(`/${API_PREFIX}/wallet`).set('Authorization', `Bearer ${back.accessToken}`)).status).toBe(200);
    const self = await admin.request(administrators.admin, { actionType: 'SUSPEND_USER', payload: { userId: administrators.admin.userId }, reason: 'x' });
    expect(self.body.details.reason).toBe('SELF_TARGETED');
  });

  describe('CLOSE_PERIOD', () => {
    it('closes a month (ACCESS EXCLUSIVE inside the approved function); backdating into it is refused afterwards', async () => {
      await refreshLogins();
      expect((await payments.reconciliation.run(ReconciliationRunKind.INTERNAL)).status).toBe('CLEAN');
      const approval = await approve({ actionType: 'CLOSE_PERIOD', payload: { month: '2020-03' }, reason: 'Q1 2020 reported' });
      expect(approval.status).toBe('EXECUTED');
      const [lock] = (await harness.dataSource.query(`SELECT locked_by, approval_id::text AS approval, period_start, period_end FROM period_locks WHERE id = $1`, [
        approval.resultReference,
      ])) as { locked_by: string; approval: string; period_start: Date; period_end: Date }[];
      expect(lock).toMatchObject({ locked_by: `operator:${checker.userId}`, approval: approval.approvalId });
      expect(lock!.period_start.toISOString()).toBe('2020-03-01T00:00:00.000Z');
      expect(lock!.period_end.toISOString()).toBe('2020-04-01T00:00:00.000Z');

      const somebody = await harness.openUserAccount('NGN');
      await expect(
        harness.ledger.post({
          transaction: { type: TransactionType.FUNDING, authorization: PostingAuthorization.SYSTEM_DRIVEN, valueTime: new Date('2020-03-15T00:00:00Z'), initiatedBy: 'job:test', userId: somebody.userId },
          entries: [
            { account: { systemAccount: 'BANK' }, direction: EntryDirection.DEBIT, amount: Money.of(100n, 'NGN') },
            { account: { accountId: somebody.accountId }, direction: EntryDirection.CREDIT, amount: Money.of(100n, 'NGN') },
          ],
        }),
      ).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
    });

    it('refuses: the same month again, an unfinished month, and (at execution, under the lock) a gap', async () => {
      await refreshLogins();
      expect((await admin.request(administrators.admin, { actionType: 'CLOSE_PERIOD', payload: { month: '2020-03' }, reason: 'x' })).body.details.reason).toBe('PERIOD_ALREADY_LOCKED');
      const future = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 7);
      expect((await admin.request(administrators.admin, { actionType: 'CLOSE_PERIOD', payload: { month: future }, reason: 'x' })).body.details.reason).toBe('PERIOD_NOT_ENDED');
      const gap = await approve({ actionType: 'CLOSE_PERIOD', payload: { month: '2020-06' }, reason: 'x' });
      expect(gap).toMatchObject({ status: 'EXECUTION_FAILED', executionFailureCode: 'PERIOD_NOT_CONTIGUOUS' });
      expect((await approve({ actionType: 'CLOSE_PERIOD', payload: { month: '2020-04' }, reason: 'April 2020 reported' })).status).toBe('EXECUTED');
    });

    it('refuses while a money break is live (you do not report books you know are wrong)', async () => {
      await refreshLogins();
      const foreign = payments.psp.createForeignPayment('9000', 'NGN');
      payments.psp.settle({ currency: 'NGN', paymentIds: [foreign] });
      await payments.reconciliation.run(ReconciliationRunKind.EXTERNAL_DAILY);
      const refused = await admin.request(administrators.admin, { actionType: 'CLOSE_PERIOD', payload: { month: '2020-05' }, reason: 'x' });
      expect(refused.status).toBe(409);
      expect(refused.body.details.reason).toBe('MONEY_BREAKS_OPEN');
    });
  });
});
