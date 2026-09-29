import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { Money } from '../../src/common/money';
import { EntryDirection, LedgerEntryDraft, PostingAuthorization, TransactionDraft, TransactionType } from '../../src/modules/ledger/ledger.types';
import { expectedHistory } from '../support/history-oracle';
import { LedgerHarness, PaymentsHarness, SignedUpUser, UserAccount, startLedgerHarness } from '../support/ledger-harness';

type Query = Record<string, string>;

const T0 = new Date('2026-03-01T08:00:00.000Z');
const T1 = new Date('2026-03-02T08:00:00.000Z');
const T2 = new Date('2026-03-03T08:00:00.000Z');

/**
 * Keyset pagination (design §7.8; PHASE8_PLAN §C, §D.6–7) through the real HTTP pipeline:
 * every limit from 1 to N+1, both sorts, each filter — each row exactly once, in order,
 * compared with an independent oracle query (EXISTS instead of the repository's DISTINCT
 * stream, no keyset). Rows sharing one value time AND one booking time (posted in one database
 * transaction) sit on page boundaries: the id tiebreak must neither repeat nor skip them.
 */
describe('Transaction history: pagination (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let alice: SignedUpUser;
  let bob: SignedUpUser;
  const accounts: Record<string, UserAccount> = {};

  beforeAll(async () => {
    harness = await startLedgerHarness({ DEMO_CREDIT_NGN_MINOR: '100000' }, { payments: true });
    payments = harness.payments!;
    alice = await payments.signUp();
    bob = await payments.signUp();
    const [{ id: walletId }] = (await harness.dataSource.query(`SELECT id FROM wallets WHERE user_id = $1`, [alice.userId])) as { id: string }[];
    for (const currency of ['NGN', 'USD', 'EUR']) {
      const account = await harness.chartOfAccounts.openUserAccount(walletId, currency);
      accounts[currency] = { userId: alice.userId, walletId, accountId: account.id, currency };
    }

    // Six NGN fundings in ONE database transaction: one value time, one booking time — pure ties.
    const tied = await harness.unitOfWork.run(async () => {
      const posted = [];
      for (let index = 0; index < 6; index += 1) posted.push(await fundAt(accounts.NGN, 100_000n + BigInt(index), T1));
      return posted;
    });
    // Four USD fundings at the same value time, in separate transactions (ties on value time only).
    for (let index = 0; index < 4; index += 1) await fundAt(accounts.USD, 5_000n + BigInt(index), T1);
    // Three conversions NGN → USD sharing one value and booking time.
    await harness.unitOfWork.run(async () => {
      for (let index = 0; index < 3; index += 1) await convertAt(10_000n, 7n + BigInt(index), T2);
    });
    // A backdated reversal of one tied funding, and a correction with TWO legs on the same account
    // (the currency stream must show it once).
    const reversal = await harness.ledger.buildReversalRequest(tied[0].transactionId, { valueTime: T0, initiatedBy: 'job:test', reasonCode: 'TEST_REVERSAL' });
    await harness.ledger.post({ ...reversal, transaction: { ...reversal.transaction, reference: `test-reversal:${tied[0].transactionId}` } });
    await harness.ledger.post({
      transaction: draft(TransactionType.CORRECTION, T2, { correctsTransactionId: tied[1].transactionId, reasonCode: 'TEST_CORRECTION' }),
      entries: [
        { account: { accountId: accounts.NGN.accountId }, direction: EntryDirection.DEBIT, amount: Money.of(100n, 'NGN') },
        { account: { accountId: accounts.NGN.accountId }, direction: EntryDirection.CREDIT, amount: Money.of(40n, 'NGN') },
        { account: { systemAccount: 'BANK' }, direction: EntryDirection.CREDIT, amount: Money.of(60n, 'NGN') },
      ],
    });
    // Fundings that never posted: two declined, then one left pending.
    for (let index = 0; index < 2; index += 1) {
      await payments.fund(alice, { amount: '150000', currency: 'NGN', paymentMethodToken: 'tok_decline_insufficient_funds' }).expect(202);
    }
    await payments.drive();
    payments.psp.setCaptureCompletion('manual');
    await payments.fund(alice, { amount: '160000', currency: 'NGN', paymentMethodToken: 'tok_success_visa' }).expect(202);
    // Bob: a little history of his own.
    const [{ id: bobWallet }] = (await harness.dataSource.query(`SELECT id FROM wallets WHERE user_id = $1`, [bob.userId])) as { id: string }[];
    const bobNgn = await harness.chartOfAccounts.openUserAccount(bobWallet, 'NGN');
    for (let index = 0; index < 3; index += 1) await fundAt({ userId: bob.userId, walletId: bobWallet, accountId: bobNgn.id, currency: 'NGN' }, 1_000n, T1);
  }, 120_000);
  afterAll(async () => harness?.close());

  function draft(type: TransactionType, valueTime: Date, extra: Partial<TransactionDraft> = {}): TransactionDraft {
    return { type, authorization: PostingAuthorization.SYSTEM_DRIVEN, valueTime, initiatedBy: 'job:test', userId: alice.userId, ...extra };
  }

  function fundAt(account: UserAccount, amountMinor: bigint, valueTime: Date) {
    const entries: LedgerEntryDraft[] = [
      { account: { systemAccount: 'BANK' }, direction: EntryDirection.DEBIT, amount: Money.of(amountMinor, account.currency) },
      { account: { accountId: account.accountId }, direction: EntryDirection.CREDIT, amount: Money.of(amountMinor, account.currency) },
    ];
    return harness.ledger.post({ transaction: { ...draft(TransactionType.FUNDING, valueTime), userId: account.userId }, entries });
  }

  async function convertAt(sourceMinor: bigint, targetMinor: bigint, valueTime: Date) {
    const conversion = await harness.conversionProvenance({ sourceCurrency: 'NGN', sourceAmountMinor: sourceMinor, targetCurrency: 'USD', targetAmountMinor: targetMinor });
    return harness.ledger.post({
      transaction: draft(TransactionType.CONVERSION, valueTime, { conversion, reasonCode: 'MARKET_CONVERSION' }),
      entries: [
        { account: { accountId: accounts.NGN.accountId }, direction: EntryDirection.DEBIT, amount: Money.of(sourceMinor, 'NGN') },
        { account: { systemAccount: 'FX_POSITION' }, direction: EntryDirection.CREDIT, amount: Money.of(sourceMinor, 'NGN') },
        { account: { systemAccount: 'FX_POSITION' }, direction: EntryDirection.DEBIT, amount: Money.of(targetMinor, 'USD') },
        { account: { accountId: accounts.USD.accountId }, direction: EntryDirection.CREDIT, amount: Money.of(targetMinor, 'USD') },
      ],
    });
  }

  const http = () => request(harness.auth!.app.getHttpServer());
  const history = (user: SignedUpUser, query: Query) =>
    http().get(`/${API_PREFIX}/transactions`).query(query).set('Authorization', `Bearer ${user.accessToken}`);

  /** Page to the end; every page full but the last, never an empty page before the end. */
  async function traverse(user: SignedUpUser, query: Query, limit: number): Promise<string[]> {
    await payments.clearRateLimits();
    const references: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; ; pages += 1) {
      if (pages > 500) throw new Error('pagination does not terminate');
      const response = await history(user, { ...query, limit: String(limit), ...(cursor ? { cursor } : {}) });
      expect(response.status).toBe(200);
      const items = response.body.items as { reference: string }[];
      references.push(...items.map((item) => item.reference));
      cursor = response.body.nextCursor;
      if (cursor === null) return references;
      expect(items).toHaveLength(limit);
    }
  }

  /** The oracle: a plain ordered query, written independently of the repository. */
  const expected = (userId: string, query: Query) => expectedHistory(harness.dataSource, userId, query);

  const FILTERS: Query[] = [
    {},
    { type: 'FUNDING' },
    { type: 'CONVERSION' },
    { type: 'REVERSAL' },
    { type: 'CORRECTION' },
    { currency: 'USD' },
    { currency: 'NGN' },
    { currency: 'NGN', type: 'FUNDING' },
    { currency: 'EUR' },
    { from: '2026-03-02T08:00:00Z', to: '2026-03-03T08:00:00.000001Z' },
  ];

  it.each(['valueTime', 'bookingTime'])('%s: every limit, every filter — each row exactly once, in order', async (sort) => {
    for (const filter of FILTERS) {
      const query = { ...filter, sort };
      const oracle = await expected(alice.userId, query);
      for (let limit = 1; limit <= Math.max(1, oracle.length + 1); limit += 1) {
        const got = await traverse(alice, query, limit);
        expect({ query, limit, got }).toEqual({ query, limit, got: oracle });
      }
    }
    // The fixture really exercises what it claims.
    const all = await expected(alice.userId, { sort });
    // demo credit + 6 tied + 4 USD + 3 conversions + reversal + correction + 3 unposted fundings.
    expect(all).toHaveLength(19);
    expect(all.filter((reference) => reference.startsWith('funding:'))).toHaveLength(3);
    expect(await expected(alice.userId, { sort, type: 'CORRECTION', currency: 'NGN' })).toHaveLength(1);
  }, 300_000);

  it('the order is value time, then booking time with its own sort, ties broken by id', async () => {
    const valueOrder = await traverse(alice, {}, 100);
    const bookingOrder = await traverse(alice, { sort: 'bookingTime' }, 100);
    expect(new Set(valueOrder)).toEqual(new Set(bookingOrder));
    // The backdated reversal is oldest by value time, not by booking time.
    expect(valueOrder[valueOrder.length - 1]).toMatch(/^test-reversal:/);
    expect(bookingOrder[bookingOrder.length - 1]).not.toMatch(/^test-reversal:/);
  });

  it('a cursor is bound to its query: another sort or other filters are INVALID_CURSOR; limit may change', async () => {
    const first = await history(alice, { limit: '2' }).expect(200);
    const cursor = first.body.nextCursor as string;
    const others: Query[] = [{ sort: 'bookingTime' }, { type: 'FUNDING' }, { currency: 'NGN' }, { from: '2026-01-01T00:00:00Z' }, { to: '2027-01-01T00:00:00Z' }];
    for (const other of others) {
      const response = await history(alice, { ...other, cursor });
      expect({ other, status: response.status, code: response.body.code }).toEqual({ other, status: 400, code: 'INVALID_CURSOR' });
    }
    const tampered = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...tampered, i: 'not-a-uuid' })).toString('base64url');
    expect((await history(alice, { cursor: forged })).body.code).toBe('INVALID_CURSOR');
    const next = await history(alice, { limit: '5', cursor }).expect(200);
    expect(next.body.items).toHaveLength(5);
  });

  it("a cursor minted on another user's page only ever narrows the caller's own rows", async () => {
    const alicePage = await history(alice, { limit: '1' }).expect(200);
    const bobOwn = await expected(bob.userId, {});
    for (const cursor of [alicePage.body.nextCursor as string]) {
      const got = await traverse(bob, {}, 100);
      expect(got).toEqual(bobOwn);
      const response = await history(bob, { cursor, limit: '100' }).expect(200);
      const references = (response.body.items as { reference: string }[]).map((item) => item.reference);
      expect(references.every((reference) => bobOwn.includes(reference))).toBe(true);
      expect(references.some((reference) => !bobOwn.includes(reference))).toBe(false);
    }
    // And a position forged anywhere in time still returns only Bob's rows.
    const decoded = JSON.parse(Buffer.from(alicePage.body.nextCursor as string, 'base64url').toString());
    for (const t of ['0', '9999999999999999']) {
      const forged = Buffer.from(JSON.stringify({ ...decoded, t })).toString('base64url');
      const response = await history(bob, { cursor: forged, limit: '100' }).expect(200);
      expect((response.body.items as { reference: string }[]).every((item) => bobOwn.includes(item.reference))).toBe(true);
    }
  });

  describe('writes during a traversal (PHASE8_PLAN §D.7: the documented contract)', () => {
    it('value time: newer rows and rows backdated into the passed range are not seen by this traversal; rows ahead of the cursor are', async () => {
      await payments.clearRateLimits();
      const before = await expected(alice.userId, {});
      const page1 = await history(alice, { limit: '8' }).expect(200);
      const seen = (page1.body.items as { reference: string; valueTime: string }[]).map((item) => item.reference);
      const passedFrom = new Date((page1.body.items as { valueTime: string }[])[7].valueTime);
      // Newer than everything (above page 1), backdated INTO the passed range, and ahead of the cursor.
      const newer = await fundAt(accounts.EUR, 1n, new Date('2026-06-01T00:00:00Z'));
      const intoPassed = await fundAt(accounts.EUR, 2n, new Date(passedFrom.getTime() + 1_000));
      const ahead = await fundAt(accounts.EUR, 3n, new Date('2026-01-15T00:00:00Z'));
      let cursor = page1.body.nextCursor as string;
      const rest: string[] = [];
      while (cursor) {
        const response = await history(alice, { limit: '8', cursor }).expect(200);
        rest.push(...(response.body.items as { reference: string }[]).map((item) => item.reference));
        cursor = response.body.nextCursor;
      }
      const traversal = [...seen, ...rest];
      expect(traversal).toContain(ahead.reference);
      expect(traversal).not.toContain(newer.reference);
      expect(traversal).not.toContain(intoPassed.reference);
      expect(traversal.filter((reference) => reference !== ahead.reference)).toEqual(before);
      // Refreshing from the top sees everything.
      const refreshed = await traverse(alice, {}, 100);
      expect(refreshed).toEqual(expect.arrayContaining([newer.reference, intoPassed.reference, ahead.reference]));
    });

    it('booking time: a booking in flight during the read commits BEHIND it; the 10s overlap re-read catches it, a naive one does not', async () => {
      await payments.clearRateLimits();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let started!: (reference: string) => void;
      const inFlightPosted = new Promise<string>((resolve) => (started = resolve));
      // EUR (own account, BANK:EUR): no lock shared with the NGN posting below.
      const inFlight = harness.unitOfWork.run(async () => {
        const posted = await fundAt(accounts.EUR, 4n, new Date());
        started(posted.reference);
        await gate;
      });
      const inFlightReference = await inFlightPosted;
      const committed = await fundAt(accounts.NGN, 5n, new Date());
      const top = (await history(alice, { sort: 'bookingTime', limit: '1' }).expect(200)).body.items[0];
      expect(top.reference).toBe(committed.reference);
      release();
      await inFlight;

      const naive = await traverse(alice, { sort: 'bookingTime', from: top.bookingTime }, 100);
      expect(naive).toContain(committed.reference);
      expect(naive).not.toContain(inFlightReference);
      const overlap = await traverse(alice, { sort: 'bookingTime', from: new Date(new Date(top.bookingTime).getTime() - 10_000).toISOString() }, 100);
      expect(overlap).toContain(inFlightReference);
    });
  });
});
