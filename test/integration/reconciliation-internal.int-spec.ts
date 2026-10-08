import { Client } from 'pg';
import { Money } from '../../src/common/money';
import { BreakType } from '../../src/modules/reconciliation/break-types';
import { BreakStatus } from '../../src/modules/reconciliation/break-transitions';
import { InternalRunResult } from '../../src/modules/reconciliation/internal-reconciliation.job';
import { ReconciliationRunStatus } from '../../src/modules/reconciliation/reconciliation-run.repository';
import { ReconciliationRunKind } from '../../src/modules/reconciliation/reconciliation-schedule';
import { LedgerHarness, ReconciliationHarness, UserAccount, startLedgerHarness } from '../support/ledger-harness';

/**
 * Internal reconciliation — the books against themselves (design §8.1), run as the worker runs
 * it: one read-only snapshot, the unchanged checks, every finding persisted, the money-is-wrong
 * ones as escalated breaks, metrics. Tampering is done as a superuser with the append-only
 * trigger disabled — exactly what the nightly job exists to catch.
 */
describe('reconciliation: internal (integration)', () => {
  let harness: LedgerHarness;
  let reconciliation: ReconciliationHarness;
  let superuser: Client;
  let account: UserAccount;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { payments: true });
    reconciliation = harness.payments!.reconciliation;
    superuser = await harness.db.superuserClient();
    account = await harness.openUserAccount('NGN');
    for (const amount of [10_000n, 25_000n, 7_500n]) await harness.fund(account, amount);
  });
  afterAll(async () => {
    await superuser?.end();
    await harness?.close();
  });

  const internal = async () => (await reconciliation.run(ReconciliationRunKind.INTERNAL)) as InternalRunResult;
  const findingsOf = async (runId: string) =>
    (await harness.dataSource.query(`SELECT kind, currency_code, subject, drift_minor::text AS drift_minor, break_id FROM reconciliation_findings WHERE run_id = $1 ORDER BY id`, [
      runId,
    ])) as { kind: string; currency_code: string | null; subject: string; drift_minor: string; break_id: string | null }[];
  const entriesOf = async (accountId: string) =>
    ((await harness.dataSource.query(`SELECT id::text AS id FROM ledger_entries WHERE account_id = $1 ORDER BY ledger_entries.id`, [accountId])) as { id: string }[]).map(
      (row) => row.id,
    );

  it('a clean ledger records a CLEAN run — with its snapshot time, and no findings', async () => {
    const result = await internal();
    expect(result.status).toBe(ReconciliationRunStatus.CLEAN);
    expect(result.breakIds).toEqual([]);
    expect(await findingsOf(result.runId)).toEqual([]);
    const [run] = (await harness.dataSource.query(`SELECT status::text AS status, snapshot_at, finished_at, summary FROM reconciliation_runs WHERE id = $1`, [
      result.runId,
    ])) as { status: string; snapshot_at: Date | null; finished_at: Date | null; summary: { clean: boolean; driftMinor: Record<string, string> } }[];
    expect(run.status).toBe('CLEAN');
    expect(run.snapshot_at).not.toBeNull();
    expect(run.finished_at).not.toBeNull();
    expect(run.summary.clean).toBe(true);
    expect(run.summary.driftMinor.NGN).toBe('0');
    expect(reconciliation.metrics.reconciliationDriftMinor().filter((row) => row.source === 'internal' && row.driftMinor !== 0n)).toEqual([]);
  });

  it('a tampered entry (content edited, hash left alone) is a HASH_CHAIN_BREAK — escalated, persisted, counted', async () => {
    const victim = await harness.openUserAccount('USD');
    for (const amount of [100n, 200n, 300n]) await harness.fund(victim, amount);
    const [, tampered] = await entriesOf(victim.accountId);
    const countBefore = reconciliation.metrics.hashChainBreaksTotal;
    await superuser.query(`ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_no_mutation`);
    // Move the entry's value time: amounts untouched, so ONLY the hash chain can tell.
    await superuser.query(`UPDATE ledger_entries SET value_time = value_time - interval '1 day' WHERE id = $1`, [tampered]);
    await superuser.query(`ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_no_mutation`);

    const result = await internal();
    expect(result.status).toBe(ReconciliationRunStatus.BREAKS_FOUND);
    expect(result.hashChainBreaks).toBe(1);
    expect(reconciliation.metrics.hashChainBreaksTotal - countBefore).toBe(1);
    const breaks = (await reconciliation.allBreaks()).filter((entry) => result.breakIds.includes(entry.id));
    expect(breaks.map((entry) => [entry.type, entry.subjectKey, entry.status, entry.ledgerAccountId])).toEqual([
      [BreakType.HASH_CHAIN_BREAK, `account:${victim.accountId}`, BreakStatus.ESCALATED, victim.accountId],
    ]);
    const findings = await findingsOf(result.runId);
    expect(findings.map((finding) => [finding.kind, finding.subject])).toEqual([
      ['HASH_CHAIN', `entry:${tampered}`],
      ['HASH_CHAIN_ACCOUNT', `account:${victim.accountId}`],
    ]);
    expect(findings[1].break_id).toBe(breaks[0].id);

    // Put it back: the next run no longer sees it, but NOTHING named a cause — it stays live, annotated.
    await superuser.query(`ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_no_mutation`);
    await superuser.query(`UPDATE ledger_entries SET value_time = value_time + interval '1 day' WHERE id = $1`, [tampered]);
    await superuser.query(`ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_no_mutation`);
    const after = await internal();
    expect(after.status).toBe(ReconciliationRunStatus.CLEAN);
    const stillLive = await reconciliation.breaks.findById(breaks[0].id);
    expect(stillLive?.status).toBe(BreakStatus.ESCALATED);
    expect(stillLive?.resolutionNote).toMatch(/No longer detected by internal run .*not resolved: no cause was named/);
  });

  it('a tampered cached balance is CACHED_BALANCE_DRIFT, and the drift gauge says exactly how much, in that currency', async () => {
    const victim = await harness.openUserAccount('EUR');
    await harness.fund(victim, 5_000n);
    await superuser.query(`UPDATE accounts SET balance_minor = balance_minor + 1234 WHERE id = $1`, [victim.accountId]);
    try {
      const result = await internal();
      expect(result.status).toBe(ReconciliationRunStatus.BREAKS_FOUND);
      const breaks = (await reconciliation.allBreaks()).filter((entry) => result.breakIds.includes(entry.id));
      const drift = breaks.find((entry) => entry.type === BreakType.CACHED_BALANCE_DRIFT);
      expect(drift).toMatchObject({ subjectKey: `account:${victim.accountId}`, currency: 'EUR', amountMinor: 1234n, status: BreakStatus.ESCALATED });
      // A raw balance edit also unbalances the accounting equation in EUR.
      expect(breaks.map((entry) => entry.type).sort()).toEqual([BreakType.ACCOUNTING_EQUATION_FAILED, BreakType.CACHED_BALANCE_DRIFT]);
      expect(result.drift.get('EUR')).toBe(2468n); // 1,234 cached + 1,234 equation: absolute, per check
      expect(result.drift.get('NGN')).toBe(0n);
      const gauge = reconciliation.metrics.reconciliationDriftMinor().find((row) => row.currency === 'EUR' && row.source === 'internal');
      expect(gauge?.driftMinor).toBe(2468n);
    } finally {
      await superuser.query(`UPDATE accounts SET balance_minor = balance_minor - 1234 WHERE id = $1`, [victim.accountId]);
    }
    expect((await internal()).status).toBe(ReconciliationRunStatus.CLEAN);
  });

  it('overdrafts and overdue reservations are FINDINGS (reported, counted), never breaks', async () => {
    const victim = await harness.openUserAccount('GBP');
    await harness.fund(victim, 1_000n);
    const [flowId] = await harness.newFlowIds(1);
    await harness.reservations.reserve({ accountId: victim.accountId, flowId, amount: Money.of(500n, 'GBP'), expiresAt: new Date(Date.now() + 1500) });
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const result = await internal();
    const findings = await findingsOf(result.runId);
    expect(findings.filter((finding) => finding.kind === 'OVERDUE_RESERVATION')).toHaveLength(1);
    expect(findings.every((finding) => finding.kind !== 'OVERDUE_RESERVATION' || finding.break_id === null)).toBe(true);
    expect(reconciliation.metrics.reservationsOverdue).toBeGreaterThanOrEqual(1);
    await harness.reservations.expireDue(new Date(), 100);
  });

  it('no false positives while postings commit concurrently: every measurement of a moving ledger is clean', async () => {
    const accounts = [await harness.openUserAccount('NGN'), await harness.openUserAccount('NGN')];
    let stop = false;
    const writers = accounts.map(async (target) => {
      let posted = 0;
      while (!stop) {
        await harness.fund(target, 1n + BigInt(posted % 7));
        posted += 1;
      }
      return posted;
    });
    try {
      for (let round = 0; round < 8; round += 1) {
        const measurement = await reconciliation.internal.measure();
        expect(measurement.ledger.isClean).toBe(true);
        expect(measurement.reservations.isClean).toBe(true);
      }
    } finally {
      stop = true;
    }
    expect((await Promise.all(writers)).every((posted) => posted > 0)).toBe(true);
  });
});

/**
 * Scale (Phase 9 §H.7): the runtime role's statement timeout (here lowered so a test-sized ledger
 * exceeds it) kills a plain whole-ledger walk; the internal run — one read-only snapshot with its
 * own timeout — completes and says so.
 */
describe('reconciliation: internal run at scale (integration)', () => {
  let harness: LedgerHarness;

  beforeAll(async () => {
    harness = await startLedgerHarness({ DB_STATEMENT_TIMEOUT_MS: '400' }, { payments: true });
  });
  afterAll(async () => harness?.close());

  it('a ledger larger than one statement can walk in the runtime timeout: the plain walk times out, the run completes CLEAN', async () => {
    const account = await harness.openUserAccount('NGN');
    await harness.fund(account, 1n); // the bank bucket and the user account exist, cache consistent
    // Seed in batches as the owner (no timeout), exactly as post() would record them: balanced
    // pairs, running balances, hash-chained by the insert trigger, the cache advanced at the end.
    const owner = await harness.db.ownerClient();
    try {
      const [{ bank_id: bankId }] = (
        await owner.query(
          `SELECT account_id AS bank_id FROM ledger_entries WHERE transaction_id = (SELECT transaction_id FROM ledger_entries WHERE account_id = $1 LIMIT 1) AND account_id <> $1`,
          [account.accountId],
        )
      ).rows as { bank_id: string }[];
      for (let batch = 0; batch < 12; batch += 1) {
        await owner.query(
          `DO $$
           DECLARE
             transaction_id UUID;
             user_balance BIGINT := (SELECT balance_minor FROM accounts WHERE id = '${account.accountId}');
             bank_balance BIGINT := (SELECT balance_minor FROM accounts WHERE id = '${bankId}');
           BEGIN
             FOR i IN 1..2500 LOOP
               transaction_id := gen_random_uuid();
               INSERT INTO transactions (id, reference, user_id, type, status, value_time, initiated_by)
                 VALUES (transaction_id, 'seed:' || transaction_id, '${account.userId}', 'FUNDING', 'POSTED', now(), 'job:scale-seed');
               bank_balance := bank_balance + 1;
               INSERT INTO ledger_entries (transaction_id, account_id, currency_code, direction, amount_minor, balance_after_minor, value_time)
                 VALUES (transaction_id, '${bankId}', 'NGN', 'DEBIT', 1, bank_balance, now());
               user_balance := user_balance + 1;
               INSERT INTO ledger_entries (transaction_id, account_id, currency_code, direction, amount_minor, balance_after_minor, value_time)
                 VALUES (transaction_id, '${account.accountId}', 'NGN', 'CREDIT', 1, user_balance, now());
             END LOOP;
             UPDATE accounts SET balance_minor = user_balance,
                    balance_entry_id = (SELECT max(id) FROM ledger_entries WHERE account_id = '${account.accountId}'), version = version + 1
              WHERE id = '${account.accountId}';
             UPDATE accounts SET balance_minor = bank_balance,
                    balance_entry_id = (SELECT max(id) FROM ledger_entries WHERE account_id = '${bankId}'), version = version + 1
              WHERE id = '${bankId}';
           END $$`,
        );
      }
    } finally {
      await owner.end();
    }

    // The runtime role's timeout kills the plain whole-ledger walk...
    await expect(harness.checks.verifyHashChains()).rejects.toThrow(/canceling statement due to statement timeout/);
    // ...the internal run, in its own snapshot with its own timeout, completes — and says so.
    const started = Date.now();
    const result = (await harness.payments!.reconciliation.run(ReconciliationRunKind.INTERNAL)) as InternalRunResult;
    expect(result.status).toBe(ReconciliationRunStatus.CLEAN);
    const [{ entries }] = (await harness.dataSource.query(`SELECT count(*)::int AS entries FROM ledger_entries`)) as { entries: number }[];
    expect(entries).toBeGreaterThan(60_000);
    const [run] = (await harness.dataSource.query(`SELECT summary FROM reconciliation_runs WHERE id = $1`, [result.runId])) as {
      summary: { clean: boolean; durationMilliseconds: number };
    }[];
    expect(run.summary.clean).toBe(true);
    expect(run.summary.durationMilliseconds).toBeGreaterThan(400);
    expect(Date.now() - started).toBeGreaterThan(400);
  }, 600_000);
});
