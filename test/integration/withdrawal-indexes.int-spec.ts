import { Client } from 'pg';
import { POSTED_UNREVERSED_PAGE, UNRESOLVED_PAYOUT_FLOWS_PAGE } from '../../src/modules/reconciliation/paystack/paystack-transfer-reconciliation';
import { CurrencyRegistry } from '../../src/modules/currencies/currency-registry';
import { StashService } from '../../src/modules/stashes/stash.service';
import { HistoryQuery, HistorySort } from '../../src/modules/transactions/history-cursor';
import { TransactionHistoryRepository } from '../../src/modules/transactions/transaction-history.repository';
import { LedgerHarness, UserAccount, startLedgerHarness } from '../support/ledger-harness';

const HEAVY_ROWS = 20_000;
const OTHER_USERS = 10;
const OTHER_ROWS = 2_000;
const SEED_BATCH = 5_000;
const LIMIT = 51;

/** Tables the W4 statements may never Seq Scan (or bitmap-scan, losing the order), and the indexes that must stream. */
const LARGE_TABLES = new Set(['paystack_withdrawals', 'stash_receipts', 'flow_instances']);

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly Plans?: readonly PlanNode[];
}

interface Scan {
  readonly node: PlanNode;
  readonly ancestors: readonly PlanNode[];
}

function scansOf(node: PlanNode, ancestors: readonly PlanNode[] = []): Scan[] {
  const own = node['Relation Name'] ? [{ node, ancestors }] : [];
  return [...own, ...(node.Plans ?? []).flatMap((child) => scansOf(child, [node, ...ancestors]))];
}

/** An index scan that feeds a Limit with no Sort in between: the keyset streams, O(limit). */
function streams(scan: Scan): boolean {
  for (const ancestor of scan.ancestors) {
    if (ancestor['Node Type'] === 'Limit') return true;
    if (ancestor['Node Type'] === 'Sort' || ancestor['Node Type'] === 'Incremental Sort') return false;
  }
  return false;
}

/**
 * W4 plans (WITHDRAWAL_PLAN.md §D.3, §J, §L W4 "SQL indexes"): the unposted-withdrawal history branch, the stash
 * reads and the reconciliation keysets, EXPLAINed exactly as the code builds them, over tables seeded large enough
 * that a scan-and-sort would otherwise win.
 *
 * Seeding goes straight into the tables as the SUPERUSER with `session_replication_role = replica` (triggers and
 * foreign keys off; every CHECK still applies): this suite checks plans, not money — its rows are not coherent
 * withdrawals, and the app role can do none of this.
 */
describe('Withdrawal, stash and payout reconciliation: index use (W4, integration, EXPLAIN)', () => {
  let harness: LedgerHarness;
  let repository: TransactionHistoryRepository;
  let stash: StashService;
  let heavy: UserAccount;
  let heavyWithdrawalId: string;

  beforeAll(async () => {
    harness = await startLedgerHarness();
    repository = new TransactionHistoryRepository(harness.unitOfWork);
    stash = new StashService(harness.unitOfWork, harness.moduleRef.get(CurrencyRegistry, { strict: false }));
    heavy = await harness.openUserAccount('NGN');
    const superuser = await harness.db.superuserClient();
    try {
      await superuser.query(`SET session_replication_role = replica`);
      await seedUser(superuser, heavy, HEAVY_ROWS);
      for (let index = 0; index < OTHER_USERS; index += 1) await seedUser(superuser, await harness.openUserAccount('NGN'), OTHER_ROWS);
      // Completed flows of other types dominate flow_instances; the unresolved payout ones are a minority.
      for (let offset = 0; offset < 30_000; offset += SEED_BATCH) {
        await superuser.query(
          `INSERT INTO flow_instances (flow_type, state, user_id, created_at, completed_at)
           SELECT 'FUNDING', 'POSTED', $1, timestamptz '2026-01-01' + series * interval '1 second', now()
             FROM generate_series($2::int + 1, $2::int + $3::int) AS series`,
          [heavy.userId, offset, SEED_BATCH],
        );
      }
    } finally {
      await superuser.end();
    }
    [{ flow_id: heavyWithdrawalId }] = (await harness.dataSource.query(
      `SELECT flow_id FROM paystack_withdrawals WHERE user_id = $1 AND posted_at IS NULL LIMIT 1`,
      [heavy.userId],
    )) as { flow_id: string }[];
    // As the owner: for anyone else ANALYZE silently skips the table (a WARNING), leaving no statistics.
    const owner = await harness.db.ownerClient();
    try {
      await owner.query(`ANALYZE paystack_withdrawals, stash_receipts, flow_instances, transactions, funding_payments, customer_stashes, currencies`);
    } finally {
      await owner.end();
    }
  }, 600_000);
  afterAll(async () => harness?.close());

  /**
   * Per user: `rows` withdrawals (a quarter unposted, half posted and not reversed, a quarter reversed), one unresolved
   * PAYSTACK_WITHDRAWAL flow per unposted one, and `rows` stash receipts (1% in USD: a rare currency).
   */
  async function seedUser(client: Client, account: UserAccount, rows: number): Promise<void> {
    for (let offset = 0; offset < rows; offset += SEED_BATCH) {
      const size = Math.min(SEED_BATCH, rows - offset);
      await client.query(
        `WITH seeded AS (
           SELECT gen_random_uuid() AS flow_id, series, timestamptz '2026-01-01' + series * interval '1 second' AS at
             FROM generate_series($3::int + 1, $3::int + $4::int) AS series
         ), flows AS (
           INSERT INTO flow_instances (id, flow_type, state, user_id, created_at, completed_at)
           SELECT flow_id, 'PAYSTACK_WITHDRAWAL',
                  CASE series % 4 WHEN 0 THEN 'PROCESSING' WHEN 3 THEN 'REVERSED' ELSE 'POSTED' END, $1, at,
                  CASE series % 4 WHEN 0 THEN NULL ELSE at END
             FROM seeded
         )
         INSERT INTO paystack_withdrawals
           (flow_id, user_id, account_id, stash_id, beneficiary_id, currency_code, principal_minor, total_debit_minor,
            provider_account_identity, provider_reference, internal_bucket, created_at,
            submission_started_at, submission_payload_sha256, principal_transaction_id, confirmation_verification_id, posted_at,
            reversal_transaction_id, return_verification_id, reversed_at)
         SELECT flow_id, $1, $2, gen_random_uuid(), gen_random_uuid(), 'NGN', 100, 100, 'seed-identity', 'withdrawal-' || flow_id::text, 0, at,
                CASE WHEN series % 4 = 0 THEN NULL ELSE at END,
                CASE WHEN series % 4 = 0 THEN NULL ELSE sha256('seed'::bytea) END,
                CASE WHEN series % 4 = 0 THEN NULL ELSE gen_random_uuid() END,
                CASE WHEN series % 4 = 0 THEN NULL ELSE gen_random_uuid() END,
                CASE WHEN series % 4 = 0 THEN NULL ELSE at + interval '1 minute' END,
                CASE WHEN series % 4 = 3 THEN gen_random_uuid() END,
                CASE WHEN series % 4 = 3 THEN gen_random_uuid() END,
                CASE WHEN series % 4 = 3 THEN at + interval '1 hour' END
           FROM seeded`,
        [account.userId, account.accountId, offset, size],
      );
      await client.query(
        `INSERT INTO stash_receipts
           (stash_id, user_id, withdrawal_id, currency_code, amount_minor, event_kind, verification_id, ledger_transaction_id,
            value_time, value_time_basis, recorded_at)
         SELECT gen_random_uuid(), $1, gen_random_uuid(), CASE WHEN series % 100 = 7 THEN 'USD' ELSE 'NGN' END, 100, 'CONFIRMATION',
                gen_random_uuid(), gen_random_uuid(), timestamptz '2026-01-01' + series * interval '1 second', 'OBSERVED_TEST_STATE',
                timestamptz '2026-01-01' + series * interval '1 second'
           FROM generate_series($2::int + 1, $2::int + $3::int) AS series`,
        [account.userId, offset, size],
      );
    }
  }

  async function planOf(sql: string, parameters: readonly unknown[]): Promise<PlanNode> {
    const [row] = (await harness.dataSource.query(`EXPLAIN (FORMAT JSON) ${sql}`, [...parameters])) as { 'QUERY PLAN': { Plan: PlanNode }[] }[];
    return row['QUERY PLAN'][0].Plan;
  }

  function expectStreams(plan: PlanNode, expectedIndex: string, where: string): void {
    const scans = scansOf(plan);
    for (const scan of scans.filter((each) => LARGE_TABLES.has(each.node['Relation Name'] as string))) {
      expect({ where, table: scan.node['Relation Name'], node: scan.node['Node Type'] }).not.toMatchObject({ node: expect.stringMatching(/^(Seq Scan|Bitmap Heap Scan)$/) });
    }
    const keyset = scans.filter((scan) => scan.node['Index Name'] === expectedIndex);
    expect({ where, used: keyset.length > 0 }).toEqual({ where, used: true });
    expect({ where, streams: keyset.every(streams) }).toEqual({ where, streams: true });
  }

  const query = (overrides: Partial<HistoryQuery>): HistoryQuery => ({
    sort: HistorySort.VALUE_TIME,
    type: null,
    currency: null,
    fromMicroseconds: null,
    toMicroseconds: null,
    ...overrides,
  });
  const position = { timeMicroseconds: 1_767_225_600_000_000n + 10_000n * 1_000_000n, id: 'ffffffff-ffff-4fff-bfff-ffffffffffff' };

  it.each([
    ['all types', query({}), 'paystack_withdrawals_unposted_user_index'],
    ['type WITHDRAWAL', query({ type: 'WITHDRAWAL' }), 'paystack_withdrawals_unposted_user_index'],
    ['currency NGN', query({ currency: 'NGN' }), 'paystack_withdrawals_unposted_user_currency_index'],
    ['type WITHDRAWAL + currency NGN, booking time', query({ type: 'WITHDRAWAL', currency: 'NGN', sort: HistorySort.BOOKING_TIME }), 'paystack_withdrawals_unposted_user_currency_index'],
  ])('history (%s): the unposted-withdrawal branch streams from its keyset index, with and without a cursor', async (_name, history, index) => {
    for (const at of [null, position]) {
      const statement = repository.buildPage({ userId: heavy.userId }, history, at, LIMIT);
      expectStreams(await planOf(statement.sql, statement.parameters), index, `${_name} cursor=${at !== null}`);
    }
  });

  it('history: a type filter that is not WITHDRAWAL has no unposted-withdrawal branch', () => {
    const statement = repository.buildPage({ userId: heavy.userId }, query({ type: 'CONVERSION' }), null, LIMIT);
    expect(statement.sql).not.toContain("'WITHDRAWAL'::text AS source");
    expect(repository.buildPage({ userId: heavy.userId }, query({ type: 'WITHDRAWAL' }), null, LIMIT).sql).toContain("'WITHDRAWAL'::text AS source");
  });

  it('history: `withdrawal:{id}` is a primary-key lookup', async () => {
    const statement = repository.buildFind({ userId: heavy.userId }, { kind: 'reference', reference: `withdrawal:${heavyWithdrawalId}`, prefix: 'withdrawal', id: heavyWithdrawalId });
    const scans = scansOf(await planOf(statement.sql, statement.parameters)).filter((scan) => scan.node['Relation Name'] === 'paystack_withdrawals');
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) expect(scan.node['Node Type']).toMatch(/Index/);
  });

  it.each([
    ['no filter', null, 'stash_receipts_user_recorded_index'],
    ['currency USD', 'USD', 'stash_receipts_user_currency_recorded_index'],
  ])('stash transactions (%s): streams from its recorded-time keyset index, with and without a cursor', async (name, currency, index) => {
    for (const at of [null, position]) {
      const statement = stash.buildPage(heavy.userId, currency, at, LIMIT);
      expectStreams(await planOf(statement.sql, statement.parameters), index, `${name} cursor=${at !== null}`);
    }
  });

  it('stash balance: one statement over the owner\'s receipts by index, never a scan of every receipt', async () => {
    const statement = stash.buildBalances(heavy.userId);
    const scans = scansOf(await planOf(statement.sql, statement.parameters)).filter((scan) => scan.node['Relation Name'] === 'stash_receipts');
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) expect(scan.node['Node Type']).not.toBe('Seq Scan');
  });

  it.each([
    ['unresolved payout flows', UNRESOLVED_PAYOUT_FLOWS_PAGE, 'flow_instances_unresolved_payout_index'],
    ['posted, not reversed withdrawals', POSTED_UNREVERSED_PAGE, 'paystack_withdrawals_posted_unreversed_index'],
  ])('reconciliation keyset (%s) streams from its partial index, from the start and from a position', async (name, sql, index) => {
    for (const parameters of [
      [null, null],
      [new Date('2026-01-01T03:00:00Z'), '00000000-0000-4000-8000-000000000000'],
    ]) {
      expectStreams(await planOf(sql, parameters), index, `${name} ${parameters[0] === null ? 'start' : 'position'}`);
    }
  });
});
