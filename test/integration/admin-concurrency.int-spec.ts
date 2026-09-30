import { randomUUID } from 'node:crypto';
import { DomainError } from '../../src/common/errors';
import { Money } from '../../src/common/money';
import { ApprovalActionType, ApprovalStatus } from '../../src/modules/admin/approvals/approval.types';
import { EntryDirection, PostingAuthorization, TransactionType } from '../../src/modules/ledger/ledger.types';
import { ReconciliationRunKind } from '../../src/modules/reconciliation/reconciliation-schedule';
import { AdminHarness, Administrators, LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

const POOL_SIZE = 12;

/**
 * Four-eyes under contention (Phase 10 plan §E.3). Every decision locks the approval row, then the people
 * involved `FOR SHARE`: two approvers, approve vs reject, approve vs cancel — exactly one wins; approve vs the
 * requester's revocation — never an approval by a requester who was no longer an admin; a retried execution —
 * exactly one posting. And the period close vs an in-flight posting. On a WARMED pool, issued back to back.
 */
describe('Admin concurrency (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let admin: AdminHarness;
  let first: Administrators;
  let checkers: SignedUpUser[];

  const warmPool = () => Promise.all(Array.from({ length: POOL_SIZE }, () => harness.dataSource.query('SELECT pg_sleep(0.2)')));
  const outcome = async (work: Promise<{ status: ApprovalStatus }>): Promise<string> => {
    try {
      return (await work).status;
    } catch (error) {
      if (error instanceof DomainError) return error.code;
      throw error;
    }
  };
  const suspension = async (): Promise<string> => {
    const target = await payments.signUp();
    const approval = await admin.approvals.request(first.admin.userId, {
      actionType: ApprovalActionType.SUSPEND_USER,
      payload: { userId: target.userId },
      reason: 'race test',
      breakGlass: false,
    });
    return approval.id;
  };

  beforeAll(async () => {
    harness = await startLedgerHarness({ DB_POOL_MAX: String(POOL_SIZE) }, { payments: true });
    payments = harness.payments!;
    admin = payments.admin;
    first = await admin.bootstrap();
    checkers = [await admin.grant('ADMIN', first.admin, first.security), await admin.grant('ADMIN', first.admin, first.security)];
  }, 180_000);

  afterAll(async () => harness?.close());

  it('two approvers at once: exactly one executes, the other is refused APPROVAL_ALREADY_DECIDED', async () => {
    for (let round = 0; round < 5; round += 1) {
      const id = await suspension();
      await warmPool();
      const results = await Promise.all([
        outcome(admin.approvals.approve(id, checkers[0]!.userId)),
        outcome(admin.approvals.approve(id, checkers[1]!.userId)),
      ]);
      expect(results.sort()).toEqual(['APPROVAL_ALREADY_DECIDED', ApprovalStatus.EXECUTED].sort());
      const [row] = (await harness.dataSource.query(
        `SELECT count(*)::int AS executed FROM audit_logs WHERE subject_id = $1 AND action = 'APPROVAL_EXECUTED'`,
        [id],
      )) as { executed: number }[];
      expect(row!.executed).toBe(1);
    }
  });

  it('approve vs reject vs cancel, back to back: one decision stands, the rest are refused', async () => {
    for (let round = 0; round < 5; round += 1) {
      const id = await suspension();
      await warmPool();
      const results = await Promise.all([
        outcome(admin.approvals.approve(id, checkers[0]!.userId)),
        outcome(admin.approvals.reject(id, checkers[1]!.userId, 'no')),
        outcome(admin.approvals.cancel(id, first.admin.userId)),
      ]);
      const winners = results.filter((result) => result !== 'APPROVAL_ALREADY_DECIDED');
      expect(winners).toHaveLength(1);
      const stored = await admin.repository.find(id);
      expect(stored!.status).toBe(winners[0]);
    }
  });

  it('approve racing the requester\'s revocation: never an approval by a requester who was no longer an admin', async () => {
    for (let round = 0; round < 3; round += 1) {
      const requester = await admin.grant('ADMIN', first.admin, first.security);
      const target = await payments.signUp();
      const id = (
        await admin.approvals.request(requester.userId, { actionType: ApprovalActionType.SUSPEND_USER, payload: { userId: target.userId }, reason: 'x', breakGlass: false })
      ).id;
      const revoke = await admin.approvals.request(first.admin.userId, {
        actionType: ApprovalActionType.ROLE_CHANGE,
        payload: { userId: requester.userId, role: 'ADMIN', operation: 'REVOKE' },
        reason: 'x',
        breakGlass: false,
      });
      await warmPool();
      const [approval, revocation] = await Promise.all([
        outcome(admin.approvals.approve(id, checkers[0]!.userId)),
        outcome(admin.approvals.approve(revoke.id, first.security.userId)),
      ]);
      expect(revocation).toBe(ApprovalStatus.EXECUTED);
      expect([ApprovalStatus.EXECUTED, 'APPROVAL_REQUESTER_INELIGIBLE']).toContain(approval);
      if (approval === ApprovalStatus.EXECUTED) {
        // It won the user row first: its approval committed while the requester still held ADMIN.
        const [times] = (await harness.dataSource.query(
          `SELECT (SELECT approved_at FROM approvals WHERE id = $1) < (SELECT approved_at FROM approvals WHERE id = $2) AS approval_first`,
          [id, revoke.id],
        )) as { approval_first: boolean }[];
        expect(times!.approval_first).toBe(true);
      }
    }
  });

  it('an execution retried under different keys, concurrently: one posting, ever', async () => {
    const debtor = await payments.signUp();
    const [account] = (await harness.dataSource.query(
      `SELECT accounts.id FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id WHERE wallets.user_id = $1 AND accounts.currency_code = 'NGN'`,
      [debtor.userId],
    )) as { id: string }[];
    await harness.ledger.post({
      transaction: { type: TransactionType.WITHDRAWAL, authorization: PostingAuthorization.SYSTEM_DRIVEN, valueTime: new Date(), initiatedBy: 'job:test', userId: debtor.userId },
      entries: [
        { account: { accountId: account!.id }, direction: EntryDirection.DEBIT, amount: Money.of(90_000n, 'NGN') },
        { account: { systemAccount: 'BANK' }, direction: EntryDirection.CREDIT, amount: Money.of(90_000n, 'NGN') },
      ],
    });
    const id = (
      await admin.approvals.request(first.admin.userId, {
        actionType: ApprovalActionType.WRITE_OFF,
        payload: { userId: debtor.userId, currency: 'NGN', amount: '90000', valueTime: new Date(Date.now() - 1000).toISOString() },
        reason: 'unrecoverable',
        breakGlass: false,
      })
    ).id;
    await payments.clearRateLimits();
    await warmPool();
    const responses = await Promise.all(Array.from({ length: 6 }, () => admin.decide(checkers[0]!, id, 'approve', {}, randomUUID())));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    const [posted] = (await harness.dataSource.query(`SELECT count(*)::int AS count FROM transactions WHERE reference = $1`, [`approval:${id}`])) as { count: number }[];
    expect(posted!.count).toBe(1);
    await harness.expectCleanBooks();
  });

  it('closing a period waits for a posting already in flight (it lands inside), then refuses the ones that follow', async () => {
    await payments.reconciliation.run(ReconciliationRunKind.INTERNAL);
    const id = (await admin.approvals.request(first.admin.userId, { actionType: ApprovalActionType.CLOSE_PERIOD, payload: { month: '2021-02' }, reason: 'Feb 2021 reported', breakGlass: false })).id;
    const somebody = await harness.openUserAccount('NGN');
    const inside = new Date('2021-02-20T10:00:00Z');

    // An in-flight posting: it has read period_locks (holding ACCESS SHARE) and not committed yet.
    const inFlight = await harness.db.appClient();
    await inFlight.query('BEGIN');
    await inFlight.query(`SELECT count(*) FROM period_locks WHERE period_start <= $1 AND $1 < period_end`, [inside]);

    let closed = false;
    const closing = admin.approvals.approve(id, checkers[0]!.userId).then((approval) => {
      closed = true;
      return approval;
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(closed).toBe(false); // ACCESS EXCLUSIVE waits for the in-flight reader
    await inFlight.query('COMMIT');
    await inFlight.end();
    expect((await closing).status).toBe(ApprovalStatus.EXECUTED);

    await expect(
      harness.ledger.post({
        transaction: { type: TransactionType.FUNDING, authorization: PostingAuthorization.SYSTEM_DRIVEN, valueTime: inside, initiatedBy: 'job:test', userId: somebody.userId },
        entries: [
          { account: { systemAccount: 'BANK' }, direction: EntryDirection.DEBIT, amount: Money.of(100n, 'NGN') },
          { account: { accountId: somebody.accountId }, direction: EntryDirection.CREDIT, amount: Money.of(100n, 'NGN') },
        ],
      }),
    ).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
  });
});
