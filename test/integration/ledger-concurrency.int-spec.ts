import { Client } from 'pg';
import { DomainError, ErrorCode } from '../../src/common/errors';
import { Money } from '../../src/common/money';
import { AccountEntity } from '../../src/modules/ledger/entities/account.entity';
import {
  EntryDirection,
  PostedTransaction,
  PostingAuthorization,
  PostingRequest,
  TransactionType,
} from '../../src/modules/ledger/ledger.types';
import { bucketForTransaction } from '../../src/modules/ledger/posting/bucket';
import { LedgerHarness, UserAccount, startLedgerHarness } from '../support/ledger-harness';

const BUCKETS = 4;
const POOL_SIZE = 20;

/** Settle every promise; split into successes and the stable codes of the failures. */
async function settle<T>(work: Promise<T>[]): Promise<{ fulfilled: T[]; failureCodes: string[]; unexpected: unknown[] }> {
  const results = await Promise.allSettled(work);
  const fulfilled: T[] = [];
  const failureCodes: string[] = [];
  const unexpected: unknown[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') fulfilled.push(result.value);
    else if (result.reason instanceof DomainError) failureCodes.push(result.reason.code);
    else unexpected.push(result.reason);
  }
  return { fulfilled, failureCodes, unexpected };
}

const transfer = (from: UserAccount, to: UserAccount, amountMinor: bigint): PostingRequest => ({
  transaction: {
    type: TransactionType.WITHDRAWAL,
    authorization: PostingAuthorization.USER_INITIATED,
    valueTime: new Date(),
    initiatedBy: `user:${from.userId}`,
    userId: from.userId,
  },
  entries: [
    { account: { accountId: from.accountId }, direction: EntryDirection.DEBIT, amount: Money.of(amountMinor, from.currency) },
    { account: { accountId: to.accountId }, direction: EntryDirection.CREDIT, amount: Money.of(amountMinor, to.currency) },
  ],
});

describe('Ledger concurrency (real pool, testcontainers)', () => {
  let harness: LedgerHarness;
  let owner: Client;

  beforeAll(async () => {
    harness = await startLedgerHarness({ LEDGER_INTERNAL_BUCKETS: String(BUCKETS), DB_POOL_MAX: String(POOL_SIZE) });
    owner = await harness.db.ownerClient();
  });

  afterAll(async () => {
    await owner?.end();
    await harness?.close();
  });

  /**
   * Open every pooled connection up front. Otherwise connections are created lazily,
   * and a new connection's authentication takes longer than a whole posting — the
   * "parallel" postings would quietly run one after another and never contend.
   */
  async function warmPool(): Promise<void> {
    await Promise.all(Array.from({ length: POOL_SIZE }, () => harness.dataSource.query('SELECT pg_sleep(0.2)')));
  }

  it('100 parallel user-initiated ₦800 debits against ₦1,000: exactly one succeeds, ₦200 remains', async () => {
    const account = await harness.openUserAccount('NGN');
    await harness.fund(account, 100_000n); // ₦1,000.00 in kobo
    await warmPool();

    const { fulfilled, failureCodes, unexpected } = await settle(
      Array.from({ length: 100 }, () =>
        harness.ledger.post({
          transaction: {
            type: TransactionType.WITHDRAWAL,
            authorization: PostingAuthorization.USER_INITIATED,
            valueTime: new Date(),
            initiatedBy: `user:${account.userId}`,
            userId: account.userId,
          },
          entries: [
            { account: { accountId: account.accountId }, direction: EntryDirection.DEBIT, amount: Money.of(80_000n, 'NGN') },
            { account: { systemAccount: 'BANK' }, direction: EntryDirection.CREDIT, amount: Money.of(80_000n, 'NGN') },
          ],
        }),
      ),
    );

    expect(unexpected).toEqual([]);
    expect(fulfilled).toHaveLength(1);
    expect(failureCodes).toHaveLength(99);
    expect(new Set(failureCodes)).toEqual(new Set([ErrorCode.INSUFFICIENT_FUNDS]));
    expect(await harness.balanceOf(account.accountId)).toBe(20_000n);

    // No orphans: exactly the funding and the one withdrawal exist for this user, each fully entered.
    const { rows } = await owner.query(
      `SELECT t.id, count(e.id)::int AS entries
         FROM transactions t LEFT JOIN ledger_entries e ON e.transaction_id = t.id
        WHERE t.user_id = $1 GROUP BY t.id`,
      [account.userId],
    );
    expect(rows.map((row: { entries: number }) => row.entries)).toEqual([2, 2]);
    const [orphans] = (
      await owner.query(
        `SELECT (SELECT count(*) FROM transactions t WHERE NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transaction_id = t.id))::int AS transactions_without_entries`,
      )
    ).rows;
    expect(orphans.transactions_without_entries).toBe(0);
    const [accountRow] = (await owner.query(`SELECT version FROM accounts WHERE id = $1`, [account.accountId])).rows;
    expect(accountRow.version).toBe(2);
    await harness.expectCleanBooks();
  });

  it('opposite-direction transfers A→B and B→A in parallel: no deadlock, exact final balances', async () => {
    const alice = await harness.openUserAccount('USD');
    const bob = await harness.openUserAccount('USD');
    await harness.fund(alice, 1_000_000n);
    await harness.fund(bob, 1_000_000n);
    await warmPool();

    const amounts = Array.from({ length: 200 }, (_, i) => BigInt((i % 13) + 1) * 100n);
    const work = amounts.map((amount, i) => (i % 2 === 0 ? transfer(alice, bob, amount) : transfer(bob, alice, amount)));
    const { fulfilled, failureCodes, unexpected } = await settle(work.map((request) => harness.ledger.post(request)));

    expect(unexpected).toEqual([]);
    expect(failureCodes).toEqual([]); // in particular: no RESOURCE_BUSY from a deadlock
    expect(fulfilled).toHaveLength(200);

    const aliceToBob = amounts.filter((_, i) => i % 2 === 0).reduce((sum, amount) => sum + amount, 0n);
    const bobToAlice = amounts.filter((_, i) => i % 2 === 1).reduce((sum, amount) => sum + amount, 0n);
    expect(await harness.balanceOf(alice.accountId)).toBe(1_000_000n - aliceToBob + bobToAlice);
    expect(await harness.balanceOf(bob.accountId)).toBe(1_000_000n + aliceToBob - bobToAlice);
    await harness.expectCleanBooks();
  });

  it('many parallel postings over the same internal accounts, in varying leg orders: no deadlock, exact per-bucket sums', async () => {
    const templates = ['BANK', 'CLEARING', 'PSP_RECEIVABLE', 'EXPENSE:PSP_FEES', 'FX_POSITION'];
    const buckets = new Map<string, AccountEntity[]>();
    for (const template of templates) buckets.set(template, await harness.chartOfAccounts.findSystemAccountBuckets(template, 'EUR'));
    const before = new Map<string, bigint>();
    for (const rows of buckets.values()) for (const account of rows) before.set(account.id, account.balanceMinor);

    const requests: PostingRequest[] = Array.from({ length: 300 }, (_, i) => {
      const amount = BigInt((i % 17) + 1);
      // Rotate which accounts are debited/credited and the order legs are listed in.
      const [debitA, creditA, debitB, creditB] = [0, 1, 2, 3].map((k) => templates[(i + k) % templates.length]);
      const legs = [
        { account: { systemAccount: debitA }, direction: EntryDirection.DEBIT, amount: Money.of(amount, 'EUR') },
        { account: { systemAccount: creditA }, direction: EntryDirection.CREDIT, amount: Money.of(amount, 'EUR') },
        { account: { systemAccount: debitB }, direction: EntryDirection.DEBIT, amount: Money.of(amount * 2n, 'EUR') },
        { account: { systemAccount: creditB }, direction: EntryDirection.CREDIT, amount: Money.of(amount * 2n, 'EUR') },
      ];
      return {
        transaction: {
          type: TransactionType.FUNDING,
          authorization: PostingAuthorization.SYSTEM_DRIVEN,
          valueTime: new Date(),
          initiatedBy: 'job:settlement-sweep',
        },
        entries: i % 2 === 0 ? legs : [...legs].reverse(),
      };
    });

    await warmPool();
    const { fulfilled, failureCodes, unexpected } = await settle(requests.map((request) => harness.ledger.post(request)));
    expect(unexpected).toEqual([]);
    expect(failureCodes).toEqual([]);
    expect(fulfilled).toHaveLength(300);

    // Independently recompute where every leg must have landed and what each bucket must hold.
    const bucketByAccountId = new Map<string, { template: string; bucket: number }>();
    for (const [template, rows] of buckets) for (const account of rows) bucketByAccountId.set(account.id, { template, bucket: account.bucket });
    const expected = new Map(before);
    const bucketsUsed = new Set<number>();
    fulfilled.forEach((posted: PostedTransaction, index) => {
      const expectedBucket = bucketForTransaction(posted.transactionId, BUCKETS);
      bucketsUsed.add(expectedBucket);
      posted.entries.forEach((entry, entryIndex) => {
        const request = requests[index].entries[entryIndex];
        const location = bucketByAccountId.get(entry.accountId);
        expect(location).toEqual({ template: (request.account as { systemAccount: string }).systemAccount, bucket: expectedBucket });
        // All five templates are ASSET/EXPENSE (DEBIT-normal) except FX_POSITION (CREDIT-normal).
        const debitNormal = location?.template !== 'FX_POSITION';
        const increases = (entry.direction === EntryDirection.DEBIT) === debitNormal;
        expected.set(entry.accountId, (expected.get(entry.accountId) as bigint) + (increases ? entry.amount.amountMinor : -entry.amount.amountMinor));
      });
    });
    expect(bucketsUsed.size).toBe(BUCKETS);

    const { rows } = await owner.query(`SELECT id, balance_minor::text AS balance FROM accounts WHERE id = ANY($1::uuid[])`, [
      [...expected.keys()],
    ]);
    const actual = new Map((rows as { id: string; balance: string }[]).map((row) => [row.id, BigInt(row.balance)]));
    expect([...expected].filter(([id, balance]) => actual.get(id) !== balance)).toEqual([]);
    await harness.expectCleanBooks();
  });

  it('parallel reversals of the same original: exactly one wins, the rest are ALREADY_CORRECTED', async () => {
    const account = await harness.openUserAccount('GBP');
    const original = await harness.fund(account, 9_000n);
    const request = await harness.ledger.buildReversalRequest(original.transactionId, {
      valueTime: new Date(),
      initiatedBy: 'operator:ops',
      reasonCode: 'CHARGEBACK',
    });
    await warmPool();
    const { fulfilled, failureCodes, unexpected } = await settle(Array.from({ length: 20 }, () => harness.ledger.post(request)));
    expect(unexpected).toEqual([]);
    expect(fulfilled).toHaveLength(1);
    expect(new Set(failureCodes)).toEqual(new Set([ErrorCode.ALREADY_CORRECTED]));
    expect(await harness.balanceOf(account.accountId)).toBe(0n);
    await harness.expectCleanBooks();
  });

  it('a system-driven posting (chargeback after spend) drives a user negative, and the overdraft check reports it', async () => {
    const account = await harness.openUserAccount('NGN');
    const funding = await harness.fund(account, 50_000n);
    // The user spends it all...
    await harness.ledger.post({
      transaction: {
        type: TransactionType.WITHDRAWAL,
        authorization: PostingAuthorization.USER_INITIATED,
        valueTime: new Date(),
        initiatedBy: `user:${account.userId}`,
      },
      entries: [
        { account: { accountId: account.accountId }, direction: EntryDirection.DEBIT, amount: Money.of(50_000n, 'NGN') },
        { account: { systemAccount: 'BANK' }, direction: EntryDirection.CREDIT, amount: Money.of(50_000n, 'NGN') },
      ],
    });
    // ...then the card funding is charged back. The world did not ask permission.
    await harness.ledger.post(
      await harness.ledger.buildReversalRequest(funding.transactionId, {
        valueTime: new Date(),
        initiatedBy: 'job:chargebacks',
        reasonCode: 'CHARGEBACK',
      }),
    );
    expect(await harness.balanceOf(account.accountId)).toBe(-50_000n);
    const report = await harness.expectCleanBooks();
    expect(report.overdrawnAccounts).toContainEqual(expect.objectContaining({ accountId: account.accountId, balanceMinor: -50_000n }));
  });
});
