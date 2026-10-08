import { Test, TestingModule } from '@nestjs/testing';
import { Clock } from '../../src/common/clock';
import { ReconciliationCheckpoint } from '../../src/modules/reconciliation/reconciliation-checkpoints';
import { ReconciliationRunStatus } from '../../src/modules/reconciliation/reconciliation-run.repository';
import { ReconciliationRunKind } from '../../src/modules/reconciliation/reconciliation-schedule';
import { ReconciliationScheduler } from '../../src/modules/reconciliation/reconciliation-scheduler';
import { WorkerModule } from '../../src/worker.module';
import { LedgerHarness, PaymentsHarness, ReconciliationHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';
import { InjectedReconciliationCrash } from '../support/reconciliation-test-doubles';

const DAY = 24 * 3600 * 1000;

/**
 * Assume the job dies between any two steps (Phase 9 §3): a run killed at every seam is resumed
 * to the same end state — one posting per batch, every flow SETTLED, each finding and break once.
 * And two worker instances never produce two runs or two postings for one batch.
 */
describe('reconciliation: crash, resume and concurrency (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let reconciliation: ReconciliationHarness;
  let user: SignedUpUser;
  let period = 0;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { payments: true });
    payments = harness.payments!;
    reconciliation = payments.reconciliation;
    user = await payments.signUp();
  });
  afterAll(async () => harness?.close());
  afterEach(() => reconciliation.checkpoints.disarm());

  const nextPeriod = () => `${4000 + (period += 1)}-01-01`;

  async function fundedPayments(count: number): Promise<{ flowIds: string[]; paymentIds: string[] }> {
    user = await payments.logIn(user); // the clock moves days between tests
    const flowIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const response = await payments.fund(user, { amount: String(100_000 + index * 1_000), currency: 'NGN', paymentMethodToken: 'tok_success_visa' });
      expect(response.status).toBe(202);
      flowIds.push(response.body.fundingId as string);
    }
    await payments.drive();
    const paymentIds = [];
    for (const flowId of flowIds) {
      const [row] = (await harness.dataSource.query(`SELECT provider_payment_id FROM funding_payments WHERE flow_id = $1`, [flowId])) as { provider_payment_id: string }[];
      paymentIds.push(row.provider_payment_id);
    }
    return { flowIds, paymentIds };
  }

  const statesOf = async (flowIds: string[]) =>
    ((await harness.dataSource.query(`SELECT state FROM flow_instances WHERE id = ANY($1::uuid[]) ORDER BY state`, [flowIds])) as { state: string }[]).map((row) => row.state);
  const settlementsOf = async (batchId: string) =>
    ((await harness.dataSource.query(`SELECT id FROM transactions WHERE type = 'SETTLEMENT' AND external_reference = $1`, [batchId])) as { id: string }[]).length;
  const runRow = async (kind: ReconciliationRunKind, key: string) => (await reconciliation.runRow(kind, key))!;

  // First: the other tests use synthetic period keys that sort after every real date.
  describe('the scheduler on the clock', () => {
    it('runs each kind once per period, and records every period nobody ran as MISSED', async () => {
      const clock = harness.auth!.clock;
      await reconciliation.scheduler.tick();
      const today = await reconciliation.runs.latestPeriod(ReconciliationRunKind.INTERNAL);
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // A second tick in the same period runs nothing new.
      const [{ before }] = (await harness.dataSource.query(`SELECT count(*)::int AS before FROM reconciliation_runs`)) as { before: number }[];
      await reconciliation.scheduler.tick();
      const [{ after }] = (await harness.dataSource.query(`SELECT count(*)::int AS after FROM reconciliation_runs`)) as { after: number }[];
      expect(after).toBe(before);
      // The worker is down for three days.
      clock.advance(3 * DAY);
      await reconciliation.scheduler.tick();
      const internal = (await harness.dataSource.query(
        `SELECT period_key, status::text AS status FROM reconciliation_runs WHERE kind = 'INTERNAL' AND period_key > $1 AND period_key < '4000' ORDER BY period_key`,
        [today],
      )) as { period_key: string; status: string }[];
      expect(internal.map((row) => row.status)).toEqual(['MISSED', 'MISSED', expect.stringMatching(/^(CLEAN|BREAKS_FOUND)$/)]);
    });
  });

  describe('the internal run', () => {
    it.each([ReconciliationCheckpoint.AFTER_SNAPSHOT, ReconciliationCheckpoint.BEFORE_COMMIT])(
      'killed at %s: nothing half-written; resumed, it finishes with each finding once',
      async (point) => {
        const account = await harness.openUserAccount('USD');
        await harness.fund(account, 10n);
        const superuser = await harness.db.superuserClient();
        await superuser.query(`UPDATE accounts SET balance_minor = balance_minor + 1 WHERE id = $1`, [account.accountId]);
        try {
          const key = nextPeriod();
          reconciliation.checkpoints.arm(point, ReconciliationRunKind.INTERNAL);
          await expect(reconciliation.scheduler.runPeriod(ReconciliationRunKind.INTERNAL, key)).rejects.toBeInstanceOf(InjectedReconciliationCrash);
          const crashed = await runRow(ReconciliationRunKind.INTERNAL, key);
          expect(crashed.status).toBe(ReconciliationRunStatus.RUNNING);
          expect(crashed.lastError).toMatch(/Injected crash/);
          const [{ findings }] = (await harness.dataSource.query(
            `SELECT count(*)::int AS findings FROM reconciliation_findings JOIN reconciliation_runs ON reconciliation_runs.id = reconciliation_findings.run_id
              WHERE reconciliation_runs.period_key = $1`,
            [key],
          )) as { findings: number }[];
          expect(findings).toBe(0); // the findings and the finish are one transaction

          const resumed = await reconciliation.scheduler.runPeriod(ReconciliationRunKind.INTERNAL, key);
          expect(resumed?.status).toBe(ReconciliationRunStatus.BREAKS_FOUND);
          const finished = await runRow(ReconciliationRunKind.INTERNAL, key);
          expect(finished.attempts).toBe(2);
          const kinds = (await harness.dataSource.query(
            `SELECT kind FROM reconciliation_findings WHERE run_id = $1 AND subject = $2 ORDER BY kind`,
            [finished.id, `account:${account.accountId}`],
          )) as { kind: string }[];
          expect(kinds.map((row) => row.kind)).toEqual(['CACHED_BALANCE']);
        } finally {
          await superuser.query(`UPDATE accounts SET balance_minor = balance_minor - 1 WHERE id = $1`, [account.accountId]);
          await superuser.end();
        }
      },
    );
  });

  describe('the external run', () => {
    it.each([
      [ReconciliationCheckpoint.BEFORE_COMMIT, 'inside the settlement transaction: nothing ingested'],
      [ReconciliationCheckpoint.AFTER_SETTLEMENT_COMMIT, 'after the settlement commit, before the flows move'],
      [ReconciliationCheckpoint.BEFORE_FINISH, 'after every step, before the run is finished'],
    ])('killed at %s (%s): resumed to the same end state — one posting, every flow SETTLED', async (point) => {
      harness.auth!.clock.advance(3 * DAY);
      const { flowIds, paymentIds } = await fundedPayments(3);
      const batchId = payments.psp.settle({ currency: 'NGN', paymentIds });
      const key = nextPeriod();

      reconciliation.checkpoints.arm(point, ReconciliationRunKind.EXTERNAL_DAILY);
      await expect(reconciliation.scheduler.runPeriod(ReconciliationRunKind.EXTERNAL_DAILY, key)).rejects.toBeInstanceOf(InjectedReconciliationCrash);
      expect((await runRow(ReconciliationRunKind.EXTERNAL_DAILY, key)).status).toBe(ReconciliationRunStatus.RUNNING);
      if (point === ReconciliationCheckpoint.BEFORE_COMMIT) {
        expect(await settlementsOf(batchId)).toBe(0);
        expect(await statesOf(flowIds)).toEqual(['POSTED', 'POSTED', 'POSTED']);
      }
      if (point === ReconciliationCheckpoint.AFTER_SETTLEMENT_COMMIT) {
        expect(await settlementsOf(batchId)).toBe(1);
        expect(await statesOf(flowIds)).toEqual(['POSTED', 'POSTED', 'POSTED']);
      }

      const resumed = await reconciliation.scheduler.runPeriod(ReconciliationRunKind.EXTERNAL_DAILY, key);
      expect(resumed?.status).toBe(ReconciliationRunStatus.CLEAN);
      expect(await settlementsOf(batchId)).toBe(1);
      expect(await statesOf(flowIds)).toEqual(['SETTLED', 'SETTLED', 'SETTLED']);
      expect((await runRow(ReconciliationRunKind.EXTERNAL_DAILY, key)).status).toBe(ReconciliationRunStatus.CLEAN);
      await harness.expectCleanBooks();
    });

    it('a worker that dies without a word (lease never released) is taken over once its lease lapses', async () => {
      const key = nextPeriod();
      const orphan = await reconciliation.runs.claim(ReconciliationRunKind.EXTERNAL_HOURLY, key, 300);
      expect(orphan).not.toBeNull();
      // Leased: nobody else may run it.
      expect(await reconciliation.scheduler.runPeriod(ReconciliationRunKind.EXTERNAL_HOURLY, key)).toBeNull();
      await harness.dataSource.query(`UPDATE reconciliation_runs SET leased_until = now() - interval '1 second' WHERE id = $1`, [orphan!.id]);
      const resumed = await reconciliation.scheduler.runPeriod(ReconciliationRunKind.EXTERNAL_HOURLY, key);
      expect(resumed).not.toBeNull();
      const row = await runRow(ReconciliationRunKind.EXTERNAL_HOURLY, key);
      expect(row.attempts).toBe(2);
      expect(row.status).not.toBe(ReconciliationRunStatus.RUNNING);
      // The zombie cannot finish it any more.
      await expect(reconciliation.runs.finish(orphan!, ReconciliationRunStatus.CLEAN, {}, null)).rejects.toThrow(/no longer leased/);
    });

    it('a finished period is never run again', async () => {
      const key = nextPeriod();
      expect(await reconciliation.scheduler.runPeriod(ReconciliationRunKind.EXTERNAL_HOURLY, key)).not.toBeNull();
      expect(await reconciliation.scheduler.runPeriod(ReconciliationRunKind.EXTERNAL_HOURLY, key)).toBeNull();
    });
  });

  describe('two worker instances', () => {
    let second: TestingModule;
    let otherScheduler: ReconciliationScheduler;

    beforeAll(async () => {
      second = await Test.createTestingModule({ imports: [WorkerModule.forRoot(harness.db.env)] })
        .overrideProvider(Clock)
        .useValue(harness.auth!.clock)
        .compile();
      await second.init();
      otherScheduler = second.get(ReconciliationScheduler);
    });
    afterAll(async () => second?.close());

    it('racing for the same period: exactly one run executes', async () => {
      const key = nextPeriod();
      const results = await Promise.all([
        reconciliation.scheduler.runPeriod(ReconciliationRunKind.EXTERNAL_HOURLY, key),
        otherScheduler.runPeriod(ReconciliationRunKind.EXTERNAL_HOURLY, key),
      ]);
      expect(results.filter((result) => result !== null)).toHaveLength(1);
      const [{ runs }] = (await harness.dataSource.query(`SELECT count(*)::int AS runs FROM reconciliation_runs WHERE period_key = $1`, [key])) as { runs: number }[];
      expect(runs).toBe(1);
    });

    it('two runs of different periods racing over one batch: ONE posting, every flow settled once', async () => {
      harness.auth!.clock.advance(3 * DAY);
      const { flowIds, paymentIds } = await fundedPayments(4);
      const batchId = payments.psp.settle({ currency: 'NGN', paymentIds });
      const [first, other] = await Promise.all([
        reconciliation.scheduler.runPeriod(ReconciliationRunKind.EXTERNAL_DAILY, nextPeriod()),
        otherScheduler.runPeriod(ReconciliationRunKind.EXTERNAL_DAILY, nextPeriod()),
      ]);
      expect(first).not.toBeNull();
      expect(other).not.toBeNull();
      expect(await settlementsOf(batchId)).toBe(1);
      expect(await statesOf(flowIds)).toEqual(['SETTLED', 'SETTLED', 'SETTLED', 'SETTLED']);
      const [{ batches }] = (await harness.dataSource.query(`SELECT count(*)::int AS batches FROM settlement_batches WHERE provider_batch_id = $1`, [batchId])) as {
        batches: number;
      }[];
      expect(batches).toBe(1);
      await harness.expectCleanBooks();
    });
  });

});
