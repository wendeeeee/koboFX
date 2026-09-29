import { HistoryQuery, HistorySort } from '../../src/modules/transactions/history-cursor';
import { HistoryStatement, TransactionHistoryRepository } from '../../src/modules/transactions/transaction-history.repository';
import { LedgerHarness, UserAccount, startLedgerHarness } from '../support/ledger-harness';

/** Rows seeded for the heavy user; the light users share the rest (`transactions` ≈ 26,000 rows, entries ≈ 52,000). */
const HEAVY_ROWS = 20_000;
const LIGHT_USERS = 19;
const LIGHT_ROWS = 300;
const UNPOSTED_FUNDINGS = 2_000;
const LIMIT = 51;
const SEED_BATCH = 2_000;

/**
 * Tables a history page may never Seq Scan, and the keyset indexes a page must STREAM from (an
 * Index or Index Only Scan feeding a Limit; a bitmap scan loses the order and would need a Sort).
 */
const LARGE_TABLES = new Set(['transactions', 'ledger_entries', 'funding_payments']);
const KEYSET_INDEXES = new Set([
  'transactions_user_value_time_index',
  'transactions_user_booking_time_index',
  'transactions_user_type_value_time_index',
  'transactions_user_type_booking_time_index',
  'ledger_entries_account_value_time_index',
  'ledger_entries_account_booking_time_index',
  'funding_payments_unposted_user_index',
  'funding_payments_unposted_user_currency_index',
]);

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly Plans?: readonly PlanNode[];
}

interface Scan {
  readonly node: PlanNode;
  /** Ancestors, nearest first. */
  readonly ancestors: readonly PlanNode[];
}

function scansOf(node: PlanNode, ancestors: readonly PlanNode[] = []): Scan[] {
  const own = node['Relation Name'] ? [{ node, ancestors }] : [];
  return [...own, ...(node.Plans ?? []).flatMap((child) => scansOf(child, [node, ...ancestors]))];
}

/**
 * Keyset pages are O(limit) — design §7.8, Phase 8 §5 point 4 — proven on the plan, not assumed:
 * over a seeded table (large enough that a scan-and-sort would otherwise be chosen), EXPLAIN every
 * statement the repository builds, for every sort × filter combination, with and without a cursor.
 *
 * - the large tables are only ever reached through an index (no Seq Scan, no Bitmap Heap Scan);
 * - each keyset index streams into a Limit with NO Sort in between (the only Sort allowed is above
 *   a Limit: the merge of ≤ 2·limit branch rows);
 * - the expected keyset index is the one used.
 */
describe('Transaction history: index use (integration, EXPLAIN)', () => {
  let harness: LedgerHarness;
  let repository: TransactionHistoryRepository;
  let heavy: { ngn: UserAccount; usd: UserAccount };
  let light: UserAccount;

  beforeAll(async () => {
    harness = await startLedgerHarness();
    repository = new TransactionHistoryRepository(harness.unitOfWork);
    const wallet = await harness.createWallet();
    heavy = { ngn: await harness.openUserAccount('NGN', wallet), usd: await harness.openUserAccount('USD', wallet) };
    await seed(heavy.ngn, HEAVY_ROWS, heavy.usd);
    for (let index = 0; index < LIGHT_USERS; index += 1) {
      const account = await harness.openUserAccount('NGN');
      await seed(account, LIGHT_ROWS);
      await seedUnpostedFundings(account, UNPOSTED_FUNDINGS / 2);
      light = account;
    }
    await seedUnpostedFundings(heavy.ngn, UNPOSTED_FUNDINGS);
    // As the owner: for anyone else ANALYZE silently skips the table (a WARNING), leaving no statistics.
    const owner = await harness.db.ownerClient();
    try {
      await owner.query(`ANALYZE transactions, ledger_entries, funding_payments, flow_instances, accounts, wallets`);
    } finally {
      await owner.end();
    }
  }, 600_000);
  afterAll(async () => harness?.close());

  /**
   * Straight into the tables (this suite's books are not "clean" — it checks plans, not money):
   * FUNDING rows, 1% PROMOTIONAL (a rare type), 1% in USD (a rare currency), one second apart.
   */
  async function seed(account: UserAccount, rows: number, rareCurrencyAccount?: UserAccount): Promise<void> {
    // In batches: the runtime role's statement_timeout (10s) applies to the seed too.
    for (let offset = 0; offset < rows; offset += SEED_BATCH) {
      await seedBatch(account, offset, Math.min(SEED_BATCH, rows - offset), rareCurrencyAccount);
    }
  }

  async function seedBatch(account: UserAccount, offset: number, rows: number, rareCurrencyAccount?: UserAccount): Promise<void> {
    const [{ id: bankNgn }] = (await harness.dataSource.query(`SELECT id FROM accounts WHERE code = 'BANK:NGN' ORDER BY bucket LIMIT 1`)) as { id: string }[];
    const [{ id: bankUsd }] = (await harness.dataSource.query(`SELECT id FROM accounts WHERE code = 'BANK:USD' ORDER BY bucket LIMIT 1`)) as { id: string }[];
    await harness.dataSource.query(
      `WITH seeded AS (
         INSERT INTO transactions (reference, user_id, type, status, value_time, initiated_by)
         SELECT 'seed:' || gen_random_uuid(), $1,
                CASE WHEN series % 100 = 7 THEN 'PROMOTIONAL' ELSE 'FUNDING' END::transaction_type,
                'POSTED', timestamptz '2026-01-01' + series * interval '1 second', 'job:seed'
           FROM generate_series($7::int + 1, $7::int + $2::int) AS series
         RETURNING id, value_time, (extract(epoch FROM value_time)::bigint % 100 = 3 AND $5::uuid IS NOT NULL) AS rare
       )
       INSERT INTO ledger_entries (transaction_id, account_id, currency_code, direction, amount_minor, balance_after_minor, value_time)
       SELECT seeded.id, leg.account_id, leg.currency, leg.direction::entry_direction, 100, 0, seeded.value_time
         FROM seeded
         CROSS JOIN LATERAL (VALUES
           (CASE WHEN seeded.rare THEN $4::uuid ELSE $3::uuid END, CASE WHEN seeded.rare THEN 'USD' ELSE 'NGN' END, 'DEBIT'),
           (CASE WHEN seeded.rare THEN $5::uuid ELSE $6::uuid END, CASE WHEN seeded.rare THEN 'USD' ELSE 'NGN' END, 'CREDIT')
         ) AS leg (account_id, currency, direction)`,
      [account.userId, rows, bankNgn, bankUsd, rareCurrencyAccount?.accountId ?? null, account.accountId, offset],
    );
  }

  async function seedUnpostedFundings(account: UserAccount, rows: number): Promise<void> {
    await harness.dataSource.query(
      `WITH flows AS (
         INSERT INTO flow_instances (flow_type, state, user_id, completed_at)
         SELECT 'FUNDING', 'FAILED', $1, now() FROM generate_series(1, $2::int)
         RETURNING id
       )
       INSERT INTO funding_payments (flow_id, user_id, account_id, currency_code, amount_minor, provider, failure_code)
       SELECT flows.id, $1, $3, 'NGN', 100000, 'simulated', 'DECLINED' FROM flows`,
      [account.userId, rows, account.accountId],
    );
  }

  const explain = async (statement: HistoryStatement): Promise<PlanNode> => {
    const [row] = (await harness.dataSource.query(`EXPLAIN (FORMAT JSON) ${statement.sql}`, [...statement.parameters])) as {
      'QUERY PLAN': { Plan: PlanNode }[];
    }[];
    return row['QUERY PLAN'][0].Plan;
  };

  /**
   * Assert the plan's shape; returns the keyset indexes it reads. `streaming`: every keyset index
   * is an Index (Only) Scan feeding a Limit with no Sort in between — O(limit). Otherwise (the
   * accepted `type` + `currency` case) only "no Seq Scan on a large table" is asserted.
   */
  const assertKeysetPlan = (plan: PlanNode, label: string, streaming: boolean): string[] => {
    const scans = scansOf(plan).filter((scan) => LARGE_TABLES.has(scan.node['Relation Name']!));
    const keyset: string[] = [];
    for (const { node, ancestors } of scans) {
      const index = node['Index Name'] ?? node.Plans?.find((child) => child['Node Type'] === 'Bitmap Index Scan')?.['Index Name'];
      const where = `${label}: ${node['Node Type']} on ${node['Relation Name']} (${index ?? 'no index'})`;
      // Never a sequential scan: O(table), not O(limit).
      expect({ where, indexed: index !== undefined }).toEqual({ where, indexed: true });
      if (!KEYSET_INDEXES.has(index!)) continue;
      keyset.push(index!);
      if (!streaming) continue;
      expect({ where, streaming: ['Index Scan', 'Index Only Scan'].includes(node['Node Type']) }).toEqual({ where, streaming: true });
      const bound = ancestors.find((ancestor) => ancestor['Node Type'] === 'Limit' || ancestor['Node Type'] === 'Sort');
      expect({ where, bound: bound?.['Node Type'] }).toEqual({ where, bound: 'Limit' });
    }
    return [...new Set(keyset)].sort();
  };

  const query = (overrides: Partial<HistoryQuery>): HistoryQuery => ({
    sort: HistorySort.VALUE_TIME,
    type: null,
    currency: null,
    fromMicroseconds: null,
    toMicroseconds: null,
    ...overrides,
  });
  const cursor = { timeMicroseconds: 1_767_225_600_000_000n + 10_000n * 1_000_000n, id: 'ffffffff-ffff-4fff-bfff-ffffffffffff' };

  /** Per case: the query, one set of acceptable keyset indexes per branch, and whether it must stream. */
  const cases: [string, Partial<HistoryQuery>, string[][], boolean][] = [];
  for (const sort of [HistorySort.VALUE_TIME, HistorySort.BOOKING_TIME]) {
    const time = sort === HistorySort.VALUE_TIME ? 'value' : 'booking';
    const unposted = ['funding_payments_unposted_user_index'];
    const unpostedInCurrency = ['funding_payments_unposted_user_currency_index'];
    // A type filter streams from the type index, or — for a type most of the user's rows have —
    // from the plain index, filtering as it goes; both are O(limit / selectivity) at worst.
    const typed = [`transactions_user_type_${time}_time_index`, `transactions_user_${time}_time_index`];
    cases.push(
      [`${sort}`, { sort }, [unposted, [`transactions_user_${time}_time_index`]], true],
      [`${sort} type=PROMOTIONAL`, { sort, type: 'PROMOTIONAL' }, [typed], true],
      [`${sort} type=FUNDING`, { sort, type: 'FUNDING' }, [unposted, typed], true],
      [`${sort} currency=USD`, { sort, currency: 'USD' }, [unpostedInCurrency, [`ledger_entries_account_${time}_time_index`]], true],
      [
        `${sort} from/to`,
        { sort, fromMicroseconds: 1_767_225_600_000_000n, toMicroseconds: 1_767_225_600_000_000n + 86_400n * 1_000_000n },
        [unposted, [`transactions_user_${time}_time_index`]],
        true,
      ],
      // Accepted (PHASE8_PLAN §C.2): bounded by the user's rows of that type or in that currency.
      [
        `${sort} currency=NGN type=PROMOTIONAL`,
        { sort, currency: 'NGN', type: 'PROMOTIONAL' },
        [[`ledger_entries_account_${time}_time_index`, ...typed, `transactions_user_type_${sort === HistorySort.VALUE_TIME ? 'booking' : 'value'}_time_index`]],
        false,
      ],
    );
  }

  it.each(cases)('%s: no sequential scan; keyset indexes stream into a Limit', async (label, overrides, branches, streaming) => {
    for (const [who, account] of [['heavy', heavy.ngn], ['light', light]] as const) {
      for (const position of [null, cursor]) {
        const where = `${label} (${who}, ${position ? 'cursor' : 'first page'})`;
        const statement = repository.buildPage({ userId: account.userId }, query(overrides), position, LIMIT);
        // O(limit) matters where a history is large: for a light user (a few hundred rows, a handful
        // matching) the planner rightly reads the matches through an index and sorts those few.
        const used = assertKeysetPlan(await explain(statement), where, streaming && who === 'heavy');
        if (who === 'light') continue;
        // Each branch reads exactly one of its acceptable indexes, and nothing else keyset-shaped is read.
        for (const acceptable of branches) {
          expect({ where, branch: acceptable, used: used.filter((index) => acceptable.includes(index)).length }).toEqual({ where, branch: acceptable, used: 1 });
        }
        expect({ where, unexpected: used.filter((index) => !branches.some((acceptable) => acceptable.includes(index))) }).toEqual({ where, unexpected: [] });
      }
    }
  });

  it('the detail lookup is a point lookup (reference, id, unposted funding)', async () => {
    const [{ reference, id }] = (await harness.dataSource.query(
      `SELECT reference, id::text AS id FROM transactions WHERE user_id = $1 LIMIT 1`,
      [heavy.ngn.userId],
    )) as { reference: string; id: string }[];
    const [{ flow_id: flowId }] = (await harness.dataSource.query(`SELECT flow_id::text AS flow_id FROM funding_payments LIMIT 1`)) as { flow_id: string }[];
    for (const lookup of [
      { kind: 'reference' as const, reference, prefix: 'seed', id: reference.slice(5) },
      { kind: 'id' as const, id },
      { kind: 'reference' as const, reference: `funding:${flowId}`, prefix: 'funding', id: flowId },
    ]) {
      const plan = await explain(repository.buildFind({ userId: heavy.ngn.userId }, lookup));
      for (const { node } of scansOf(plan).filter((scan) => LARGE_TABLES.has(scan.node['Relation Name']!))) {
        expect({ lookup: lookup.kind, node: node['Node Type'] }).toEqual({ lookup: lookup.kind, node: expect.stringMatching(/^(Index (Only )?Scan|Bitmap Heap Scan)$/) });
      }
    }
  });
});
