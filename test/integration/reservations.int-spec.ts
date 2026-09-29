import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { ErrorCode } from '../../src/common/errors';
import { Money } from '../../src/common/money';
import { EntryDirection, PostingAuthorization, TransactionType } from '../../src/modules/ledger/ledger.types';
import { ReservationMetrics } from '../../src/modules/reservations/reservation-metrics';
import { ReservationStatus, SettlementPosting } from '../../src/modules/reservations/reservation.types';
import { LedgerHarness, UserAccount, startLedgerHarness } from '../support/ledger-harness';

const inOneHour = () => new Date(Date.now() + 60 * 60 * 1000);
const code = (expected: ErrorCode) => expect.objectContaining({ code: expected });

/** A withdrawal-shaped settlement: DEBIT the user the actual, CREDIT the bank. */
const spend = (account: UserAccount, amountMinor: bigint): SettlementPosting => ({
  transaction: {
    type: TransactionType.WITHDRAWAL,
    valueTime: new Date(),
    initiatedBy: `user:${account.userId}`,
    userId: account.userId,
  },
  entries: [
    { account: { accountId: account.accountId }, direction: EntryDirection.DEBIT, amount: Money.of(amountMinor, account.currency) },
    { account: { systemAccount: 'BANK' }, direction: EntryDirection.CREDIT, amount: Money.of(amountMinor, account.currency) },
  ],
});

/** A direct, user-initiated debit that bypasses reservations — judged by the gate against available. */
const directDebit = (account: UserAccount, amountMinor: bigint) => ({
  transaction: {
    type: TransactionType.WITHDRAWAL,
    authorization: PostingAuthorization.USER_INITIATED,
    valueTime: new Date(),
    initiatedBy: `user:${account.userId}`,
    userId: account.userId,
  },
  entries: [
    { account: { accountId: account.accountId }, direction: EntryDirection.DEBIT, amount: Money.of(amountMinor, account.currency) },
    { account: { systemAccount: 'BANK' }, direction: EntryDirection.CREDIT, amount: Money.of(amountMinor, account.currency) },
  ],
});

/** Design §5.6: NGN → USD, five entries, the spread booked to revenue. */
const conversion = (source: UserAccount, target: UserAccount, sourceMinor: bigint, targetMinor: bigint, spreadMinor: bigint): SettlementPosting => ({
  transaction: {
    type: TransactionType.CONVERSION,
    valueTime: new Date(),
    initiatedBy: `user:${source.userId}`,
    userId: source.userId,
  },
  entries: [
    { account: { accountId: source.accountId }, direction: EntryDirection.DEBIT, amount: Money.of(sourceMinor, source.currency) },
    { account: { systemAccount: 'FX_POSITION' }, direction: EntryDirection.CREDIT, amount: Money.of(sourceMinor, source.currency) },
    { account: { systemAccount: 'FX_POSITION' }, direction: EntryDirection.DEBIT, amount: Money.of(targetMinor + spreadMinor, target.currency) },
    { account: { accountId: target.accountId }, direction: EntryDirection.CREDIT, amount: Money.of(targetMinor, target.currency) },
    { account: { systemAccount: 'REVENUE:FX_SPREAD' }, direction: EntryDirection.CREDIT, amount: Money.of(spreadMinor, target.currency) },
  ],
});

describe('ReservationService (real Postgres 16)', () => {
  let harness: LedgerHarness;
  let flowIds: string[] = [];
  /** A real flow id (reservations.flow_id is a foreign key since Phase 5). */
  const nextFlowId = (): string => {
    const id = flowIds.pop();
    if (!id) throw new Error('flow id pool exhausted');
    return id;
  };
  let owner: Client;

  beforeAll(async () => {
    harness = await startLedgerHarness();
    flowIds = await harness.newFlowIds(500);
    owner = await harness.db.ownerClient();
  });

  afterAll(async () => {
    await owner?.end();
    await harness?.close();
  });

  async function funded(currency: string, amountMinor: bigint, wallet?: { userId: string; walletId: string }): Promise<UserAccount> {
    const account = await harness.openUserAccount(currency, wallet);
    if (amountMinor > 0n) await harness.fund(account, amountMinor);
    return account;
  }

  const reserve = (account: UserAccount, amountMinor: bigint, flowId: string = nextFlowId(), expiresAt = inOneHour()) =>
    harness.reservations.reserve({ accountId: account.accountId, flowId, amount: Money.of(amountMinor, account.currency), expiresAt });

  describe('reserve', () => {
    it('holds against available: reserved goes up, the balance and the ledger do not move', async () => {
      const account = await funded('NGN', 100_000n);
      const before = await harness.snapshot();
      const reservation = await reserve(account, 80_000n);

      expect(reservation).toMatchObject({ accountId: account.accountId, status: ReservationStatus.ACTIVE, settledAmount: null, resolvedAt: null });
      expect(reservation.amount.equals(Money.of(80_000n, 'NGN'))).toBe(true);
      expect(await harness.reservedOf(account.accountId)).toBe(80_000n);
      expect(await harness.balanceOf(account.accountId)).toBe(100_000n);
      const after = await harness.snapshot();
      expect(after.transactionCount).toBe(before.transactionCount);
      expect(after.entryCount).toBe(before.entryCount);
      expect(await harness.reservations.findById(reservation.id)).toEqual(reservation);
      await harness.expectCleanBooks();
    });

    it('refuses a hold the total cannot cover with INSUFFICIENT_FUNDS, and one only other holds block with FUNDS_RESERVED — writing nothing', async () => {
      const account = await funded('NGN', 100_000n);
      await reserve(account, 80_000n);
      const before = await harness.snapshot();

      await expect(reserve(account, 100_001n)).rejects.toThrow(code(ErrorCode.INSUFFICIENT_FUNDS));
      await expect(reserve(account, 80_000n)).rejects.toThrow(
        expect.objectContaining({
          code: ErrorCode.FUNDS_RESERVED,
          details: expect.objectContaining({ availableMinor: '20000', reservedMinor: '80000' }),
        }),
      );
      expect(await harness.snapshot()).toEqual(before);
      await reserve(account, 20_000n); // exactly the available remainder
      expect(await harness.reservedOf(account.accountId)).toBe(100_000n);
    });

    it('honours the overdraft limit, exactly like the posting gate', async () => {
      const account = await funded('NGN', 1_000n);
      await owner.query(`UPDATE accounts SET overdraft_limit_minor = 500 WHERE id = $1`, [account.accountId]);
      await expect(reserve(account, 1_501n)).rejects.toThrow(code(ErrorCode.INSUFFICIENT_FUNDS));
      await reserve(account, 1_500n);
    });

    it('a direct user-initiated debit is then gated against available: the held funds cannot back it', async () => {
      const account = await funded('NGN', 100_000n);
      await reserve(account, 80_000n);
      await expect(harness.ledger.post(directDebit(account, 20_001n))).rejects.toThrow(code(ErrorCode.FUNDS_RESERVED));
      await harness.ledger.post(directDebit(account, 20_000n));
      expect(await harness.balanceOf(account.accountId)).toBe(80_000n);
      await harness.expectCleanBooks();
    });

    it('is idempotent per (flow, account): a retry returns the same hold, even after it was released', async () => {
      const account = await funded('NGN', 100_000n);
      const flowId = nextFlowId();
      const first = await reserve(account, 30_000n, flowId);
      const before = await harness.snapshot();

      expect(await reserve(account, 30_000n, flowId, new Date(Date.now() + 999_999))).toEqual(first);
      expect(await harness.snapshot()).toEqual(before);

      const released = await harness.reservations.release(first.id);
      const afterRelease = await harness.snapshot();
      expect(await reserve(account, 30_000n, flowId)).toEqual(released); // no second hold
      expect(await harness.snapshot()).toEqual(afterRelease);
      expect(await harness.reservedOf(account.accountId)).toBe(0n);
    });

    it('a retry with a different amount is RESERVATION_CONFLICT; the same flow may hold on another account', async () => {
      const wallet = await harness.createWallet();
      const naira = await funded('NGN', 100_000n, wallet);
      const dollars = await funded('USD', 10_000n, wallet);
      const flowId = nextFlowId();
      await reserve(naira, 30_000n, flowId);
      await expect(reserve(naira, 30_001n, flowId)).rejects.toThrow(code(ErrorCode.RESERVATION_CONFLICT));
      await reserve(dollars, 5_000n, flowId);
      expect(await harness.reservedOf(dollars.accountId)).toBe(5_000n);
    });

    it('refuses malformed requests — nothing is written', async () => {
      const account = await funded('NGN', 100_000n);
      const [bank] = await harness.chartOfAccounts.findSystemAccountBuckets('BANK', 'NGN');
      const before = await harness.snapshot();
      const request = { accountId: account.accountId, flowId: nextFlowId(), amount: Money.of(1n, 'NGN'), expiresAt: inOneHour() };

      await expect(harness.reservations.reserve({ ...request, accountId: bank.id })).rejects.toThrow(code(ErrorCode.INVALID_RESERVATION));
      await expect(harness.reservations.reserve({ ...request, accountId: randomUUID() })).rejects.toThrow(code(ErrorCode.ACCOUNT_NOT_FOUND));
      await expect(harness.reservations.reserve({ ...request, amount: Money.of(1n, 'USD') })).rejects.toThrow(code(ErrorCode.INVALID_RESERVATION));
      await expect(harness.reservations.reserve({ ...request, amount: Money.of(0n, 'NGN') })).rejects.toThrow(code(ErrorCode.INVALID_RESERVATION));
      await expect(harness.reservations.reserve({ ...request, amount: Money.of(-5n, 'NGN') })).rejects.toThrow(code(ErrorCode.INVALID_RESERVATION));
      await expect(harness.reservations.reserve({ ...request, expiresAt: new Date(Date.now() - 1_000) })).rejects.toThrow(
        code(ErrorCode.INVALID_RESERVATION),
      );
      expect(await harness.snapshot()).toEqual(before);
    });
  });

  describe('settle', () => {
    it('less than the estimate: posts the actual, releases the whole hold, records the settlement', async () => {
      const account = await funded('NGN', 100_000n);
      const reservation = await reserve(account, 80_000n);
      const settled = await harness.reservations.settle(reservation.id, spend(account, 75_000n));

      expect(settled.status).toBe(ReservationStatus.SETTLED);
      expect(settled.settledAmount?.equals(Money.of(75_000n, 'NGN'))).toBe(true);
      expect(settled.resolvedAt).toBeInstanceOf(Date);
      expect(await harness.balanceOf(account.accountId)).toBe(25_000n);
      expect(await harness.reservedOf(account.accountId)).toBe(0n);
      const { rows } = await owner.query(`SELECT type, user_id FROM transactions WHERE id = $1`, [settled.settlementTransactionId]);
      expect(rows).toEqual([{ type: 'WITHDRAWAL', user_id: account.userId }]);
      await harness.expectCleanBooks();
    });

    it('equal to the estimate', async () => {
      const account = await funded('NGN', 100_000n);
      const reservation = await reserve(account, 80_000n);
      await harness.reservations.settle(reservation.id, spend(account, 80_000n));
      expect(await harness.balanceOf(account.accountId)).toBe(20_000n);
      expect(await harness.reservedOf(account.accountId)).toBe(0n);
    });

    it('more than the estimate: the excess is booked as an overdraft, never refused (§16)', async () => {
      const account = await funded('NGN', 100_000n);
      const other = await reserve(account, 20_000n);
      const reservation = await reserve(account, 80_000n);
      // Beyond this hold, beyond the other hold, and beyond the whole balance.
      const settled = await harness.reservations.settle(reservation.id, spend(account, 130_000n));
      expect(settled.settledAmount?.equals(Money.of(130_000n, 'NGN'))).toBe(true);
      expect(await harness.balanceOf(account.accountId)).toBe(-30_000n);
      expect(await harness.reservedOf(account.accountId)).toBe(20_000n);
      const report = await harness.expectCleanBooks();
      expect(report.overdrawnAccounts).toContainEqual(expect.objectContaining({ accountId: account.accountId, balanceMinor: -30_000n }));
      expect((await harness.reservations.findById(other.id))?.status).toBe(ReservationStatus.ACTIVE);
    });

    it('a retried settle returns the original settlement and posts nothing; a different actual is RESERVATION_CONFLICT', async () => {
      const account = await funded('NGN', 100_000n);
      const reservation = await reserve(account, 80_000n);
      const first = await harness.reservations.settle(reservation.id, spend(account, 70_000n));
      const before = await harness.snapshot();

      expect(await harness.reservations.settle(reservation.id, spend(account, 70_000n))).toEqual(first);
      await expect(harness.reservations.settle(reservation.id, spend(account, 70_001n))).rejects.toThrow(
        code(ErrorCode.RESERVATION_CONFLICT),
      );
      expect(await harness.snapshot()).toEqual(before);
    });

    it('after RELEASED: RESERVATION_NOT_ACTIVE, nothing written', async () => {
      const account = await funded('NGN', 100_000n);
      const reservation = await reserve(account, 80_000n);
      await harness.reservations.release(reservation.id);
      const before = await harness.snapshot();
      await expect(harness.reservations.settle(reservation.id, spend(account, 80_000n))).rejects.toThrow(
        code(ErrorCode.RESERVATION_NOT_ACTIVE),
      );
      expect(await harness.snapshot()).toEqual(before);
    });

    it('after EXPIRED: a late settlement is booked; the hold, already returned, is not released twice', async () => {
      const account = await funded('NGN', 100_000n);
      const reservation = await reserve(account, 80_000n);
      const { expired } = await harness.reservations.expireDue(new Date(reservation.expiresAt.getTime() + 1), 1_000);
      expect(expired.map((r) => r.id)).toContain(reservation.id);
      const expiredAt = (await harness.reservations.findById(reservation.id))?.resolvedAt;

      const settled = await harness.reservations.settle(reservation.id, spend(account, 80_000n));
      expect(settled.status).toBe(ReservationStatus.SETTLED);
      expect(settled.resolvedAt).toEqual(expiredAt); // set once, at the first resolution
      expect(await harness.balanceOf(account.accountId)).toBe(20_000n);
      expect(await harness.reservedOf(account.accountId)).toBe(0n);
      await harness.expectCleanBooks();
    });

    it('refuses postings that are not a settlement of this hold — nothing written', async () => {
      const wallet = await harness.createWallet();
      const account = await funded('NGN', 100_000n, wallet);
      const stranger = await funded('NGN', 100_000n);
      const reservation = await reserve(account, 80_000n);
      const before = await harness.snapshot();

      const alsoDebitsStranger: SettlementPosting = {
        transaction: spend(account, 1n).transaction,
        entries: [
          ...spend(account, 50_000n).entries.slice(0, 1),
          { account: { accountId: stranger.accountId }, direction: EntryDirection.DEBIT, amount: Money.of(10_000n, 'NGN') },
          { account: { systemAccount: 'BANK' }, direction: EntryDirection.CREDIT, amount: Money.of(60_000n, 'NGN') },
        ],
      };
      await expect(harness.reservations.settle(reservation.id, alsoDebitsStranger)).rejects.toThrow(code(ErrorCode.INVALID_RESERVATION));
      await expect(harness.reservations.settle(reservation.id, spend(stranger, 10_000n))).rejects.toThrow(code(ErrorCode.INVALID_RESERVATION));
      const userInitiated = { ...spend(account, 10n), transaction: { ...spend(account, 10n).transaction, authorization: PostingAuthorization.USER_INITIATED } };
      await expect(harness.reservations.settle(reservation.id, userInitiated as SettlementPosting)).rejects.toThrow(
        code(ErrorCode.INVALID_RESERVATION),
      );
      await expect(harness.reservations.settle(randomUUID(), spend(account, 10n))).rejects.toThrow(code(ErrorCode.RESERVATION_NOT_FOUND));
      expect(await harness.snapshot()).toEqual(before);
    });

    it('a failure later in the surrounding unit rolls back the posting, the settlement and the release together', async () => {
      const account = await funded('NGN', 100_000n);
      const reservation = await reserve(account, 80_000n);
      const before = await harness.snapshot();
      await expect(
        harness.unitOfWork.run(async () => {
          await harness.reservations.settle(reservation.id, spend(account, 80_000n));
          throw new Error('the surrounding command failed');
        }),
      ).rejects.toThrow('the surrounding command failed');
      expect(await harness.snapshot()).toEqual(before);
    });

    it('the §7.7 shape in one unit: lock both wallets → reserve → post + settle; no hold is left', async () => {
      const wallet = await harness.createWallet();
      const naira = await funded('NGN', 100_000n, wallet);
      const dollars = await funded('USD', 0n, wallet);
      const settled = await harness.unitOfWork.run(async () => {
        await harness.ledger.lockUserAccounts([naira.accountId, dollars.accountId]);
        const hold = await reserve(naira, 80_000n);
        return harness.reservations.settle(hold.id, conversion(naira, dollars, 80_000n, 5_000n, 25n));
      });
      expect(settled.status).toBe(ReservationStatus.SETTLED);
      expect(await harness.balanceOf(naira.accountId)).toBe(20_000n);
      expect(await harness.balanceOf(dollars.accountId)).toBe(5_000n);
      expect(await harness.reservedOf(naira.accountId)).toBe(0n);
      await harness.expectCleanBooks();
    });
  });

  describe('release', () => {
    it('returns the whole hold; a retry and a release after settle are no-ops returning the current state', async () => {
      const account = await funded('NGN', 100_000n);
      const reservation = await reserve(account, 80_000n);
      const released = await harness.reservations.release(reservation.id);
      expect(released).toMatchObject({ status: ReservationStatus.RELEASED, settledAmount: null });
      expect(await harness.reservedOf(account.accountId)).toBe(0n);

      const before = await harness.snapshot();
      expect(await harness.reservations.release(reservation.id)).toEqual(released);
      expect(await harness.snapshot()).toEqual(before);

      const other = await reserve(account, 10_000n);
      const settled = await harness.reservations.settle(other.id, spend(account, 10_000n));
      const afterSettle = await harness.snapshot();
      expect(await harness.reservations.release(other.id)).toEqual(settled);
      expect(await harness.snapshot()).toEqual(afterSettle);
      await expect(harness.reservations.release(randomUUID())).rejects.toThrow(code(ErrorCode.RESERVATION_NOT_FOUND));
    });
  });

  describe('expireDue — the safety net', () => {
    it('expires only ACTIVE reservations past expires_at, in batches, exactly once, counting them', async () => {
      const metrics = harness.moduleRef.get(ReservationMetrics);
      // Far-future clock so earlier tests' holds are cleared first; then work in a window of our own.
      await harness.reservations.expireDue(new Date('2999-01-01T00:00:00Z'), 10_000);
      const account = await funded('NGN', 100_000n);
      const base = Date.now() + 10 * 60 * 1000;
      const due = [await reserve(account, 1_000n, nextFlowId(), new Date(base + 1)), await reserve(account, 2_000n, nextFlowId(), new Date(base + 2))];
      const notYet = await reserve(account, 4_000n, nextFlowId(), new Date(base + 60_000));
      const settledEarly = await reserve(account, 8_000n, nextFlowId(), new Date(base + 3));
      await harness.reservations.settle(settledEarly.id, spend(account, 8_000n));

      const counted = metrics.reservationsExpiredTotal;
      expect(await harness.reservationChecks.findOverdueReservations(new Date(base + 10))).toHaveLength(2);
      const firstBatch = await harness.reservations.expireDue(new Date(base + 10), 1);
      expect(firstBatch.expired.map((r) => r.id)).toEqual([due[0].id]);
      const secondBatch = await harness.reservations.expireDue(new Date(base + 10), 10);
      expect(secondBatch.expired.map((r) => r.id)).toEqual([due[1].id]);
      expect(secondBatch.expired[0]).toMatchObject({ status: ReservationStatus.EXPIRED });
      expect((await harness.reservations.expireDue(new Date(base + 10), 10)).expired).toEqual([]);

      expect(metrics.reservationsExpiredTotal).toBe(counted + 2);
      expect(await harness.reservedOf(account.accountId)).toBe(4_000n);
      expect((await harness.reservations.findById(notYet.id))?.status).toBe(ReservationStatus.ACTIVE);
      expect(await metrics.reservationsActive()).toBe(1);
      const report = await harness.reservationChecks.runAllChecks(new Date(base + 10));
      expect(report).toEqual({ reservedBalanceMismatches: [], overdueReservations: [], isClean: true });
      await expect(harness.reservations.release(due[0].id)).resolves.toMatchObject({ status: ReservationStatus.EXPIRED });
      await harness.expectCleanBooks();
    });

    it('never blocks: a reservation whose account another transaction holds is skipped, then expired next run', async () => {
      const account = await funded('NGN', 100_000n);
      const reservation = await reserve(account, 1_000n);
      const later = new Date(reservation.expiresAt.getTime() + 1);
      const holder = await harness.db.appClient();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT id FROM accounts WHERE id = $1 FOR UPDATE`, [account.accountId]);
        const started = Date.now();
        const { expired } = await harness.reservations.expireDue(later, 1_000);
        expect(expired.map((r) => r.id)).not.toContain(reservation.id);
        expect(Date.now() - started).toBeLessThan(2_000); // well under lock_timeout: it did not wait
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
      const { expired } = await harness.reservations.expireDue(later, 1_000);
      expect(expired.map((r) => r.id)).toContain(reservation.id);
      await harness.expectCleanBooks();
    });

    it('refuses a non-positive batch size', async () => {
      await expect(harness.reservations.expireDue(new Date(), 0)).rejects.toThrow(code(ErrorCode.INVALID_RESERVATION));
    });
  });

  describe('the read-side checks (§8.1 item 4)', () => {
    it('report reserved_minor ≠ Σ ACTIVE; an overdue hold is reported but is not "unclean"', async () => {
      const account = await funded('NGN', 100_000n);
      const reservation = await reserve(account, 1_000n);
      const overdue = await harness.reservationChecks.runAllChecks(new Date(reservation.expiresAt.getTime() + 1));
      expect(overdue.isClean).toBe(true);
      expect(overdue.overdueReservations).toContainEqual(
        expect.objectContaining({ reservationId: reservation.id, accountId: account.accountId, amountMinor: 1_000n }),
      );

      const superuser = await harness.db.superuserClient();
      try {
        await superuser.query(`UPDATE accounts SET reserved_minor = reserved_minor + 7 WHERE id = $1`, [account.accountId]);
        const report = await harness.reservationChecks.runAllChecks();
        expect(report.isClean).toBe(false);
        expect(report.reservedBalanceMismatches).toEqual([
          expect.objectContaining({ accountId: account.accountId, reservedMinor: 1_007n, activeReservationsMinor: 1_000n }),
        ]);
      } finally {
        await superuser.query(`UPDATE accounts SET reserved_minor = reserved_minor - 7 WHERE id = $1`, [account.accountId]);
        await superuser.end();
      }
      await harness.expectCleanBooks();
    });
  });

  describe('the lock-order guard', () => {
    it('newly locking a lower-id user account after a higher one in one transaction is INVARIANT_VIOLATION', async () => {
      const wallet = await harness.createWallet();
      const [low, high] = [await funded('NGN', 100_000n, wallet), await funded('USD', 0n, wallet)].sort((a, b) =>
        a.accountId < b.accountId ? -1 : 1,
      );
      const before = await harness.snapshot();
      await expect(
        harness.unitOfWork.run(async () => {
          await harness.ledger.lockUserAccounts([high.accountId]);
          await harness.ledger.lockUserAccounts([high.accountId]); // re-locking a held row is fine
          await harness.ledger.lockUserAccounts([low.accountId]);
        }),
      ).rejects.toThrow(code(ErrorCode.INVARIANT_VIOLATION));
      await harness.unitOfWork.run(async () => {
        await harness.ledger.lockUserAccounts([low.accountId]);
        await harness.ledger.lockUserAccounts([high.accountId]); // ascending: fine
      });
      expect(await harness.snapshot()).toEqual(before);
    });

    it('requires a transaction', async () => {
      await expect(harness.ledger.lockUserAccounts([randomUUID()])).rejects.toThrow(code(ErrorCode.INVARIANT_VIOLATION));
    });
  });

  describe('schema guards', () => {
    let app: Client;
    let reservationId: string;

    beforeAll(async () => {
      app = await harness.db.appClient();
      const account = await funded('NGN', 100_000n);
      reservationId = (await reserve(account, 1_000n)).id;
    });
    afterAll(async () => app?.end());

    const asOwner = (sql: string, params: unknown[] = []) => owner.query(sql, params);

    it('amount, account, flow and expiry are immutable (trigger)', async () => {
      for (const assignment of ['amount_minor = 2', 'flow_id = gen_random_uuid()', `expires_at = now() + interval '9 days'`]) {
        await expect(asOwner(`UPDATE reservations SET ${assignment} WHERE id = $1`, [reservationId])).rejects.toThrow(/immutable/);
      }
    });

    it('status moves only along the transition table; resolution fields are set once', async () => {
      await expect(asOwner(`UPDATE reservations SET status = 'ACTIVE' WHERE id = $1`, [reservationId])).resolves.toBeDefined(); // unchanged
      await asOwner(`UPDATE reservations SET status = 'RELEASED', resolved_at = now() WHERE id = $1`, [reservationId]);
      await expect(asOwner(`UPDATE reservations SET status = 'ACTIVE', resolved_at = NULL WHERE id = $1`, [reservationId])).rejects.toThrow(
        /cannot move from RELEASED to ACTIVE/,
      );
      await expect(asOwner(`UPDATE reservations SET resolved_at = now() + interval '1 day' WHERE id = $1`, [reservationId])).rejects.toThrow(
        /already recorded its resolution/,
      );
      await asOwner(`UPDATE accounts SET reserved_minor = reserved_minor - 1000 WHERE id = (SELECT account_id FROM reservations WHERE id = $1)`, [
        reservationId,
      ]);
    });

    it('CHECK constraints: a SETTLED row records its settlement; a resolved row records when', async () => {
      const account = await funded('NGN', 100_000n);
      const { id } = await reserve(account, 1_000n);
      await expect(asOwner(`UPDATE reservations SET status = 'SETTLED', resolved_at = now() WHERE id = $1`, [id])).rejects.toThrow(
        /reservations_settlement_recorded_when_settled/,
      );
      await expect(asOwner(`UPDATE reservations SET status = 'EXPIRED' WHERE id = $1`, [id])).rejects.toThrow(
        /reservations_resolved_unless_active/,
      );
      await expect(
        asOwner(`INSERT INTO reservations (account_id, flow_id, amount_minor, expires_at) VALUES ($1, gen_random_uuid(), 0, now())`, [
          account.accountId,
        ]),
      ).rejects.toThrow(/reservations_amount_positive/);
    });

    it('one reservation per (flow, account), by construction', async () => {
      const account = await funded('NGN', 100_000n);
      const { flowId } = await reserve(account, 1_000n);
      await expect(
        asOwner(`INSERT INTO reservations (account_id, flow_id, amount_minor, expires_at) VALUES ($1, $2, 5, now())`, [
          account.accountId,
          flowId,
        ]),
      ).rejects.toThrow(/reservations_flow_account_unique/);
    });

    it('fx_app cannot DELETE or TRUNCATE, nor UPDATE the immutable columns', async () => {
      await expect(app.query(`DELETE FROM reservations WHERE id = $1`, [reservationId])).rejects.toThrow(/permission denied/);
      await expect(app.query(`TRUNCATE reservations`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`UPDATE reservations SET amount_minor = 5 WHERE id = $1`, [reservationId])).rejects.toThrow(/permission denied/);
      await expect(app.query(`UPDATE reservations SET resolved_at = resolved_at WHERE id = $1`, [reservationId])).resolves.toBeDefined();
    });

    it('even a superuser cannot DELETE a reservation (trigger)', async () => {
      const superuser = await harness.db.superuserClient();
      try {
        await expect(superuser.query(`DELETE FROM reservations WHERE id = $1`, [reservationId])).rejects.toThrow(/never deleted/);
      } finally {
        await superuser.end();
      }
    });
  });
});
