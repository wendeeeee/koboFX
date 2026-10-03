import { Client } from 'pg';
import { Money } from '../../src/common/money';
import { FlowRepository } from '../../src/modules/flows/flow.repository';
import { EntryDirection, PostingAuthorization, TransactionType } from '../../src/modules/ledger/ledger.types';
import { ReservationExpiryPolicy, ReservationStatus } from '../../src/modules/reservations/reservation.types';
import { resolvePayoutAccounts } from '../../src/modules/withdrawals/withdrawal-accounts';
import { measureWithdrawalUsage } from '../../src/modules/withdrawals/withdrawal-usage';
import { LedgerHarness, startLedgerHarness, UserAccount } from '../support/ledger-harness';
import { WithdrawalFixtures } from '../support/withdrawal-fixtures';

/**
 * W1 shared-primitive deltas (WITHDRAWAL_PLAN.md §G.2, §G.3, §K; D5): protected holds against the sweeper, with the
 * old AUTOMATIC expiry and legal late settlement unchanged; the internal-account lock helper and its order guards; a
 * forced interleaving that deadlocks without the helper and serialises with it; the pre-flow owner lock; the 24-hour
 * usage measured at wall time under the account lock.
 */
describe('Withdrawal holds and locks', () => {
  let harness: LedgerHarness;
  let fixtures: WithdrawalFixtures;
  let owner: Client;

  beforeAll(async () => {
    harness = await startLedgerHarness();
    fixtures = new WithdrawalFixtures(harness);
    owner = await harness.db.ownerClient();
  });
  afterAll(async () => {
    await owner?.end();
    await harness?.close();
  });

  const fundedAccount = async (amountMinor = 1_000_000n): Promise<UserAccount> => {
    const account = await harness.openUserAccount('NGN');
    await harness.fund(account, amountMinor);
    return account;
  };
  const admitted = async (principalMinor = 300_000n, account?: UserAccount) => {
    const funded = account ?? (await fundedAccount());
    return fixtures.admit(funded, await fixtures.readyBeneficiary(funded.userId), principalMinor);
  };
  /** Make a reservation overdue without waiting: a superuser skips the triggers for this ONE transaction's UPDATE. */
  const makeOverdue = async (reservationId: string) => {
    const superuser = await harness.db.superuserClient();
    try {
      await superuser.query('BEGIN');
      await superuser.query(`SET LOCAL session_replication_role = replica`);
      await superuser.query(`UPDATE reservations SET expires_at = now() - interval '1 hour' WHERE id = $1`, [reservationId]);
      await superuser.query('COMMIT');
    } finally {
      await superuser.end();
    }
  };

  describe('protected holds vs the sweeper', () => {
    it('an overdue FLOW_CONTROLLED hold is skipped; an overdue AUTOMATIC hold still expires (regression)', async () => {
      const protectedHold = await admitted();
      await makeOverdue(protectedHold.reservationId);

      const automaticAccount = await fundedAccount();
      const [flowId] = await harness.newFlowIds(1);
      const automatic = await harness.reservations.reserve({
        accountId: automaticAccount.accountId,
        flowId,
        amount: Money.of(50_000n, 'NGN'),
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(automatic.expiryPolicy).toBe(ReservationExpiryPolicy.AUTOMATIC);
      await makeOverdue(automatic.id);

      const { expired } = await harness.reservations.expireDue(new Date(), 1_000);
      const expiredIds = expired.map((reservation) => reservation.id);
      expect(expiredIds).toContain(automatic.id);
      expect(expiredIds).not.toContain(protectedHold.reservationId);
      expect((await harness.reservations.findById(protectedHold.reservationId))?.status).toBe(ReservationStatus.ACTIVE);
      expect(await harness.reservedOf(protectedHold.owner.accountId)).toBe(300_000n);
      expect(await harness.reservedOf(automaticAccount.accountId)).toBe(0n);

      // Reserved totals still include the overdue protected hold; it is reported overdue, never freed.
      await harness.expectCleanBooks();
      const overdue = await harness.reservationChecks.findOverdueReservations();
      expect(overdue.map((row) => row.reservationId)).toContain(protectedHold.reservationId);
    });

    it('a late settlement of an EXPIRED automatic hold stays legal (regression)', async () => {
      const account = await fundedAccount();
      const [flowId] = await harness.newFlowIds(1);
      const hold = await harness.reservations.reserve({
        accountId: account.accountId,
        flowId,
        amount: Money.of(10_000n, 'NGN'),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await makeOverdue(hold.id);
      await harness.reservations.expireDue(new Date(), 1_000);
      const settled = await harness.reservations.settle(hold.id, {
        transaction: { type: TransactionType.FUNDING, valueTime: new Date(), initiatedBy: 'job:test', userId: account.userId },
        entries: [
          { account: { accountId: account.accountId }, direction: EntryDirection.DEBIT, amount: Money.of(10_000n, 'NGN') },
          { account: { systemAccount: 'BANK' }, direction: EntryDirection.CREDIT, amount: Money.of(10_000n, 'NGN') },
        ],
      });
      expect(settled.status).toBe(ReservationStatus.SETTLED);
      await harness.expectCleanBooks();
    });

    it('a reserve retry with a different expiry policy is a conflict, never a weaker hold', async () => {
      const withdrawal = await admitted();
      await expect(
        harness.reservations.reserve({
          accountId: withdrawal.owner.accountId,
          flowId: withdrawal.flowId,
          amount: Money.of(300_000n, 'NGN'),
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).rejects.toMatchObject({ code: 'RESERVATION_CONFLICT' });
      const replay = await harness.reservations.reserve({
        accountId: withdrawal.owner.accountId,
        flowId: withdrawal.flowId,
        amount: Money.of(300_000n, 'NGN'),
        expiresAt: new Date(Date.now() + 60_000),
        expiryPolicy: ReservationExpiryPolicy.FLOW_CONTROLLED,
      });
      expect(replay.id).toBe(withdrawal.reservationId);
    });
  });

  describe('internal-account locks', () => {
    it('guards the order: internal ids ascend across calls; no user account after internal accounts; internal only', async () => {
      const account = await fundedAccount();
      const accounts = await resolvePayoutAccounts(harness.unitOfWork.manager, 'NGN', 0);
      const [low, high] = [accounts.payoutBalanceId, accounts.payoutInTransitId].sort();

      await expect(
        harness.unitOfWork.run(async () => {
          await harness.ledger.lockInternalAccounts([low]);
          await harness.ledger.lockUserAccounts([account.accountId]);
        }),
      ).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' });
      await expect(
        harness.unitOfWork.run(async () => {
          await harness.ledger.lockInternalAccounts([high]);
          await harness.ledger.lockInternalAccounts([low]);
        }),
      ).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' });
      await expect(
        harness.unitOfWork.run(() => harness.ledger.lockInternalAccounts([account.accountId])),
      ).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' });
      // The documented order passes, and re-locking held rows is free.
      await harness.unitOfWork.run(async () => {
        await harness.ledger.lockUserAccounts([account.accountId]);
        await harness.ledger.lockInternalAccounts([low, high]);
        await harness.ledger.lockInternalAccounts([low]);
        await harness.ledger.lockUserAccounts([account.accountId]);
      });
    });

    /**
     * Two units post over the shared payout accounts in opposite orders, forced to interleave: each makes its first
     * posting (on accounts the other's first does not touch), then waits (≤ 1.5s) for the other's first before its
     * second, which needs the account the other's first holds. Without the helper the seconds cross — Postgres reports
     * a deadlock. With the helper each unit locks its whole union ascending first, so the second unit waits at the
     * helper until the first commits: no deadlock, both succeed.
     */
    it.each([
      ['without the helper, the crossed postings deadlock', false],
      ['with the helper, they serialise and both succeed', true],
    ])('%s', async (_label, useHelper) => {
      // Warm the pool so the two units really run on two connections at once.
      await Promise.all(Array.from({ length: 4 }, () => harness.dataSource.query('SELECT 1')));
      const accounts = await resolvePayoutAccounts(harness.unitOfWork.manager, 'NGN', 1);
      const privateAccount = async (code: string) =>
        ((await harness.dataSource.query(`SELECT id FROM accounts WHERE code = $1 AND bucket = 1 AND wallet_id IS NULL`, [code])) as {
          id: string;
        }[])[0].id;
      const [onlyA, onlyB] = [await privateAccount('BANK:NGN'), await privateAccount('CLEARING:NGN')];
      const amount = Money.of(100n, 'NGN');
      const post = (debitId: string, creditId: string) =>
        harness.ledger.post({
          transaction: { type: TransactionType.SETTLEMENT, authorization: PostingAuthorization.SYSTEM_DRIVEN, valueTime: new Date(),
            initiatedBy: 'job:lock-test' },
          entries: [
            { account: { accountId: debitId }, direction: EntryDirection.DEBIT, amount },
            { account: { accountId: creditId }, direction: EntryDirection.CREDIT, amount },
          ],
        });
      const signals = { a: false, b: false };
      const waitFor = async (other: 'a' | 'b') => {
        const deadline = Date.now() + 1_500;
        while (!signals[other] && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      };
      const unit = (self: 'a' | 'b', union: string[], first: [string, string], second: [string, string]) =>
        harness.unitOfWork.run(async () => {
          if (useHelper) await harness.ledger.lockInternalAccounts(union);
          await post(...first);
          signals[self] = true;
          await waitFor(self === 'a' ? 'b' : 'a');
          await post(...second);
        });

      const { payoutInTransitId: inTransit, transferFeesId: fees } = accounts;
      const results = await Promise.allSettled([
        unit('a', [inTransit, fees, onlyA], [inTransit, onlyA], [fees, onlyA]),
        unit('b', [inTransit, fees, onlyB], [fees, onlyB], [inTransit, onlyB]),
      ]);
      const reasons = results.flatMap((result) => (result.status === 'rejected' ? [String((result.reason as Error).message)] : []));
      if (useHelper) {
        expect(reasons).toEqual([]);
      } else {
        expect(reasons).toHaveLength(1);
        expect(reasons[0]).toMatch(/deadlock|busy|lock/i);
      }
      await harness.expectCleanBooks();
    });
  });

  describe('the pre-flow owner lock', () => {
    it('a commit with lockOwnerFirst waits for a concurrent suspension holding the user row, then proceeds', async () => {
      const { userId } = await harness.createWallet();
      const [flow] = (await harness.dataSource.query(
        `INSERT INTO flow_instances (flow_type, state, user_id) VALUES ('FUNDING', 'INITIATED', $1) RETURNING id`,
        [userId],
      )) as { id: string }[];
      const repository = new FlowRepository(harness.unitOfWork);
      const claimed = await repository.claimOne(flow.id, 60, false);
      expect(claimed).not.toBeNull();

      await owner.query('BEGIN');
      await owner.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
      let committed = false;
      const commit = repository
        .commit(claimed!, 'INITIATED', { retryInSeconds: 5, note: 'waited' }, undefined, async () => undefined, { lockOwnerFirst: true })
        .then(() => {
          committed = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(committed).toBe(false);
      await owner.query('COMMIT');
      await commit;
      expect(committed).toBe(true);
      const [row] = (await harness.dataSource.query(`SELECT last_error, lease_token FROM flow_instances WHERE id = $1`, [flow.id])) as {
        last_error: string;
        lease_token: string | null;
      }[];
      expect(row).toEqual({ last_error: 'waited', lease_token: null });
    });
  });

  describe('24-hour usage', () => {
    it('counts outstanding of any age and completions in the window; failures stop counting; reversals keep counting', async () => {
      const account = await fundedAccount(10_000_000n);
      const outstanding = await admitted(100_000n, account);
      const failed = await admitted(200_000n, account);
      await fixtures.fail(failed, { sent: false });
      const recent = await admitted(300_000n, account);
      await fixtures.complete(recent);
      const old = await admitted(400_000n, account);
      await fixtures.complete(old, { postedAt: new Date(Date.now() - 25 * 3_600_000) });
      const reversed = await admitted(500_000n, account);
      const completion = await fixtures.complete(reversed);
      await fixtures.reverse(reversed, completion);

      const usage = await harness.unitOfWork.run(async (manager) => {
        await harness.ledger.lockUserAccounts([account.accountId]);
        return measureWithdrawalUsage(manager, account.accountId);
      });
      expect(usage).toEqual({ outstandingMinor: 100_000n, completedInWindowMinor: 800_000n });
      void outstanding;
      await harness.expectCleanBooks();
    });
  });
});
