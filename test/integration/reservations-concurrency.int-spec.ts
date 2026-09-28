import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DomainError, ErrorCode } from '../../src/common/errors';
import { Money } from '../../src/common/money';
import { EntryDirection, PostingAuthorization, TransactionType } from '../../src/modules/ledger/ledger.types';
import { ReservationMetrics } from '../../src/modules/reservations/reservation-metrics';
import { Reservation, ReservationStatus, SettlementPosting } from '../../src/modules/reservations/reservation.types';
import { LedgerHarness, UserAccount, startLedgerHarness } from '../support/ledger-harness';

const POOL_SIZE = 20;
const inOneHour = () => new Date(Date.now() + 60 * 60 * 1000);

/** Settle every promise; split into successes and the stable codes of the failures. */
async function outcomes<T>(work: Promise<T>[]): Promise<{ fulfilled: T[]; failureCodes: string[]; unexpected: unknown[] }> {
  const results = await Promise.allSettled(work);
  const fulfilled: T[] = [];
  const failureCodes: string[] = [];
  const unexpected: unknown[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') fulfilled.push(result.value);
    else if (result.reason instanceof DomainError && result.reason.code !== ErrorCode.INVARIANT_VIOLATION) failureCodes.push(result.reason.code);
    else unexpected.push(result.reason);
  }
  return { fulfilled, failureCodes, unexpected };
}

const spend = (account: UserAccount, amountMinor: bigint): SettlementPosting => ({
  transaction: { type: TransactionType.WITHDRAWAL, valueTime: new Date(), initiatedBy: `user:${account.userId}`, userId: account.userId },
  entries: [
    { account: { accountId: account.accountId }, direction: EntryDirection.DEBIT, amount: Money.of(amountMinor, account.currency) },
    { account: { systemAccount: 'BANK' }, direction: EntryDirection.CREDIT, amount: Money.of(amountMinor, account.currency) },
  ],
});

/** NGN → USD at a flat ₦160/$1 with a 25-cent spread — the §5.6 five entries, minus a real rate (Phase 7). */
const conversion = (source: UserAccount, target: UserAccount, sourceMinor: bigint): SettlementPosting => {
  const targetMinor = sourceMinor / 160n;
  const spreadMinor = 25n;
  return {
    transaction: { type: TransactionType.CONVERSION, valueTime: new Date(), initiatedBy: `user:${source.userId}`, userId: source.userId },
    entries: [
      { account: { accountId: source.accountId }, direction: EntryDirection.DEBIT, amount: Money.of(sourceMinor, 'NGN') },
      { account: { systemAccount: 'FX_POSITION' }, direction: EntryDirection.CREDIT, amount: Money.of(sourceMinor, 'NGN') },
      { account: { systemAccount: 'FX_POSITION' }, direction: EntryDirection.DEBIT, amount: Money.of(targetMinor, 'USD') },
      { account: { accountId: target.accountId }, direction: EntryDirection.CREDIT, amount: Money.of(targetMinor - spreadMinor, 'USD') },
      { account: { systemAccount: 'REVENUE:FX_SPREAD' }, direction: EntryDirection.CREDIT, amount: Money.of(spreadMinor, 'USD') },
    ],
  };
};

describe('Reservation concurrency (real pool, testcontainers)', () => {
  let harness: LedgerHarness;
  let owner: Client;

  beforeAll(async () => {
    harness = await startLedgerHarness({ DB_POOL_MAX: String(POOL_SIZE) });
    owner = await harness.db.ownerClient();
  });

  afterAll(async () => {
    await owner?.end();
    await harness?.close();
  });

  /**
   * Open every pooled connection up front. Otherwise connections open lazily, one
   * connection's authentication outlasts a whole operation, and the "parallel" calls
   * quietly run one after another and never contend (CLAUDE.md, Phase 2 lesson).
   */
  async function warmPool(): Promise<void> {
    await Promise.all(Array.from({ length: POOL_SIZE }, () => harness.dataSource.query('SELECT pg_sleep(0.2)')));
  }

  async function funded(currency: string, amountMinor: bigint, wallet?: { userId: string; walletId: string }): Promise<UserAccount> {
    const account = await harness.openUserAccount(currency, wallet);
    if (amountMinor > 0n) await harness.fund(account, amountMinor);
    return account;
  }

  const reserve = (account: UserAccount, amountMinor: bigint, expiresAt = inOneHour()) =>
    harness.reservations.reserve({ accountId: account.accountId, flowId: randomUUID(), amount: Money.of(amountMinor, account.currency), expiresAt });

  const reservationRows = async (accountId: string) =>
    (await owner.query(`SELECT id, status FROM reservations WHERE account_id = $1`, [accountId])).rows as { id: string; status: string }[];

  const transactionCount = async (userId: string) =>
    ((await owner.query(`SELECT count(*)::int AS n FROM transactions WHERE user_id = $1`, [userId])).rows[0] as { n: number }).n;

  it('100 parallel reservations of ₦800 against ₦1,000: exactly one holds, 99 are FUNDS_RESERVED, ₦200 stays available', async () => {
    const account = await funded('NGN', 100_000n);
    await warmPool();
    const { fulfilled, failureCodes, unexpected } = await outcomes(Array.from({ length: 100 }, () => reserve(account, 80_000n)));

    expect(unexpected).toEqual([]);
    expect(fulfilled).toHaveLength(1);
    expect(failureCodes).toHaveLength(99);
    // Not INSUFFICIENT_FUNDS: the ₦1,000 total covers ₦800, it is only held (the Phase 2 gate; plan Q9).
    expect(new Set(failureCodes)).toEqual(new Set([ErrorCode.FUNDS_RESERVED]));
    expect(await harness.reservedOf(account.accountId)).toBe(80_000n);
    expect((await harness.balanceOf(account.accountId)) - (await harness.reservedOf(account.accountId))).toBe(20_000n);
    expect(await reservationRows(account.accountId)).toEqual([{ id: fulfilled[0].id, status: 'ACTIVE' }]); // no stray rows
    await harness.expectCleanBooks();
  });

  it('reservations racing direct user-initiated debits of the same funds: exactly one wins', async () => {
    const account = await funded('NGN', 100_000n);
    await warmPool();
    const debit = () =>
      harness.ledger.post({
        transaction: {
          type: TransactionType.WITHDRAWAL,
          authorization: PostingAuthorization.USER_INITIATED,
          valueTime: new Date(),
          initiatedBy: `user:${account.userId}`,
          userId: account.userId,
        },
        entries: spend(account, 80_000n).entries,
      });
    const work: Promise<unknown>[] = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? reserve(account, 80_000n) : debit()));
    const { fulfilled, failureCodes, unexpected } = await outcomes(work);

    expect(unexpected).toEqual([]);
    expect(fulfilled).toHaveLength(1);
    expect(failureCodes).toHaveLength(99);
    const reservations = await reservationRows(account.accountId);
    const debits = (await transactionCount(account.userId)) - 1; // minus the funding
    expect(reservations.length + debits).toBe(1);
    // Whichever won, ₦800 of the ₦1,000 is spoken for and ₦200 is available.
    const balance = await harness.balanceOf(account.accountId);
    const reserved = await harness.reservedOf(account.accountId);
    expect(balance - reserved).toBe(20_000n);
    await harness.expectCleanBooks();
  });

  it('concurrent duplicate settles of one reservation: one posting; every duplicate returns the original settlement', async () => {
    const account = await funded('NGN', 100_000n);
    const reservation = await reserve(account, 80_000n);
    await warmPool();
    const { fulfilled, failureCodes, unexpected } = await outcomes(
      Array.from({ length: 50 }, () => harness.reservations.settle(reservation.id, spend(account, 75_000n))),
    );

    expect(unexpected).toEqual([]);
    expect(failureCodes).toEqual([]);
    expect(fulfilled).toHaveLength(50);
    expect(new Set(fulfilled.map((settled) => JSON.stringify(settled)))).toHaveProperty('size', 1);
    expect(fulfilled[0].status).toBe(ReservationStatus.SETTLED);
    expect(await transactionCount(account.userId)).toBe(2); // funding + exactly one settlement
    expect(await harness.balanceOf(account.accountId)).toBe(25_000n);
    expect(await harness.reservedOf(account.accountId)).toBe(0n);
    await harness.expectCleanBooks();
  });

  it('settle racing release racing expireDue on the same reservation: one terminal outcome, reserved exact, no double release or posting', async () => {
    const ROUNDS = 40;
    const accounts = await Promise.all(Array.from({ length: ROUNDS }, () => funded('NGN', 100_000n)));
    const reservations: Reservation[] = [];
    for (const account of accounts) reservations.push(await reserve(account, 80_000n, new Date(Date.now() + 5 * 60 * 1000)));
    const pastExpiry = new Date(Date.now() + 10 * 60 * 1000);
    await warmPool();

    // Each reservation's three commands are issued back to back, in a rotating order, so
    // they reach the pool together and genuinely contend (issuing all settles first would
    // let them finish before any release started).
    const settles: Promise<Reservation>[] = [];
    const releases: Promise<Reservation>[] = [];
    const sweeps: Promise<{ expired: readonly Reservation[] }>[] = [];
    reservations.forEach((reservation, i) => {
      const commands = [
        () => settles.push(harness.reservations.settle(reservation.id, spend(accounts[i], 80_000n))),
        () => releases.push(harness.reservations.release(reservation.id)),
        () => sweeps.push(harness.reservations.expireDue(pastExpiry, 1_000)),
      ];
      for (let k = 0; k < commands.length; k += 1) commands[(i + k) % commands.length]();
    });
    const settleOutcomes = await outcomes(settles);
    const releaseOutcomes = await outcomes(releases);
    const sweepOutcomes = await outcomes(sweeps);

    expect([...settleOutcomes.unexpected, ...releaseOutcomes.unexpected, ...sweepOutcomes.unexpected]).toEqual([]);
    expect(new Set(settleOutcomes.failureCodes)).toEqual(new Set(settleOutcomes.failureCodes.length ? [ErrorCode.RESERVATION_NOT_ACTIVE] : []));
    expect(releaseOutcomes.failureCodes).toEqual([]);
    expect(sweepOutcomes.failureCodes).toEqual([]);
    const expiredIds = sweepOutcomes.fulfilled.flatMap((result) => result.expired.map((reservation) => reservation.id));
    expect(new Set(expiredIds).size).toBe(expiredIds.length); // no reservation expired twice

    const seen = new Set<string>();
    for (const [i, account] of accounts.entries()) {
      const [row] = (
        await owner.query(`SELECT status, settlement_transaction_id FROM reservations WHERE id = $1`, [reservations[i].id])
      ).rows as { status: ReservationStatus; settlement_transaction_id: string | null }[];
      seen.add(row.status);
      const postings = (await transactionCount(account.userId)) - 1;
      expect(await harness.reservedOf(account.accountId)).toBe(0n);
      if (row.status === ReservationStatus.SETTLED) {
        expect(postings).toBe(1);
        expect(await harness.balanceOf(account.accountId)).toBe(20_000n);
      } else {
        expect(row.status).toBe(ReservationStatus.RELEASED); // EXPIRED would have been late-settled
        expect(postings).toBe(0);
        expect(await harness.balanceOf(account.accountId)).toBe(100_000n);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
    await harness.expectCleanBooks();
  });

  it('two sweepers in parallel: each expired reservation is processed exactly once', async () => {
    const metrics = harness.moduleRef.get(ReservationMetrics);
    await harness.reservations.expireDue(new Date('2999-01-01T00:00:00Z'), 100_000); // clear earlier tests' holds
    const accounts = await Promise.all(Array.from({ length: 20 }, () => funded('NGN', 1_000_000n)));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const created: Reservation[] = [];
    for (let i = 0; i < 200; i += 1) created.push(await reserve(accounts[i % accounts.length], 1_000n, expiresAt));
    const now = new Date(expiresAt.getTime() + 1);
    const countedBefore = metrics.reservationsExpiredTotal;
    await warmPool();

    const sweeper = async (): Promise<string[]> => {
      const processed: string[] = [];
      while ((await harness.reservationChecks.findOverdueReservations(now)).length > 0) {
        const { expired } = await harness.reservations.expireDue(now, 15);
        processed.push(...expired.map((reservation) => reservation.id));
      }
      return processed;
    };
    const [first, second] = await Promise.all([sweeper(), sweeper()]);

    expect(first.filter((id) => second.includes(id))).toEqual([]);
    expect([...first, ...second].sort()).toEqual(created.map((reservation) => reservation.id).sort());
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0); // both really worked, side by side
    expect(metrics.reservationsExpiredTotal - countedBefore).toBe(200);
    for (const account of accounts) expect(await harness.reservedOf(account.accountId)).toBe(0n);
    await harness.expectCleanBooks();
  });

  it('the §7.7 shape, 100 × ₦800 against ₦1,000, each reserve → post → settle in one transaction: one succeeds, ₦200 left, nothing ACTIVE', async () => {
    const wallet = await harness.createWallet();
    const naira = await funded('NGN', 100_000n, wallet);
    const dollars = await funded('USD', 0n, wallet);
    await warmPool();

    const attempt = () =>
      harness.unitOfWork.run(async () => {
        await harness.ledger.lockUserAccounts([naira.accountId, dollars.accountId]);
        const hold = await reserve(naira, 80_000n);
        return harness.reservations.settle(hold.id, conversion(naira, dollars, 80_000n));
      });
    const { fulfilled, failureCodes, unexpected } = await outcomes(Array.from({ length: 100 }, attempt));

    expect(unexpected).toEqual([]);
    expect(fulfilled).toHaveLength(1);
    expect(failureCodes).toHaveLength(99);
    // The winner already settled when each loser gets the lock: balance ₦200, nothing held.
    expect(new Set(failureCodes)).toEqual(new Set([ErrorCode.INSUFFICIENT_FUNDS]));
    expect(await harness.balanceOf(naira.accountId)).toBe(20_000n);
    expect(await harness.balanceOf(dollars.accountId)).toBe(80_000n / 160n - 25n);
    expect(await harness.reservedOf(naira.accountId)).toBe(0n);
    expect(await reservationRows(naira.accountId)).toEqual([{ id: fulfilled[0].id, status: 'SETTLED' }]);
    expect(await transactionCount(naira.userId)).toBe(2); // the funding and the one conversion
    await harness.expectCleanBooks();
  });
});
