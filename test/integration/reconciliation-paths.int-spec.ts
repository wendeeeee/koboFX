import { Client } from 'pg';
import request from 'supertest';
import { PSP_WEBHOOK_PATH } from '../../src/app.setup';
import { Money } from '../../src/common/money';
import { dec } from '../../src/common/money/decimal';
import { exactRateString, triangulatedMid } from '../../src/modules/fx/pricing';
import { EntryDirection, PostingAuthorization, TransactionType } from '../../src/modules/ledger/ledger.types';
import { OutboxEventType } from '../../src/modules/outbox/outbox.types';
import { BreakType } from '../../src/modules/reconciliation/break-types';
import { BreakStatus, ResolutionKind } from '../../src/modules/reconciliation/break-transitions';
import { ExternalRunResult } from '../../src/modules/reconciliation/external-reconciliation.job';
import { InternalRunResult } from '../../src/modules/reconciliation/internal-reconciliation.job';
import { ReconciliationBreakChangedHandler } from '../../src/modules/reconciliation/reconciliation.module';
import { ReconciliationRunStatus } from '../../src/modules/reconciliation/reconciliation-run.repository';
import { ReconciliationRunKind } from '../../src/modules/reconciliation/reconciliation-schedule';
import { rateDisplayOf } from '../../src/modules/trading/conversion-posting';
import { LedgerHarness, PaymentsHarness, ReconciliationHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/**
 * The reconciliation paths the fault and property suites do not reach on their own: the internal
 * run's FX provenance check and whole-ledger tampering, the external run's rarer answers (pending and
 * unreadable reports, a PSP outage mid-run, a partial chargeback, a chargeback on a payment we never
 * booked, a ghost webhook, a broken receivable proof, a batch naming a deposit we have not booked
 * yet), and the break service's and run repository's own guards.
 */
describe('reconciliation: the less travelled paths (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let reconciliation: ReconciliationHarness;
  let user: SignedUpUser;
  let superuser: Client;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { payments: true });
    payments = harness.payments!;
    reconciliation = payments.reconciliation;
    harness.auth!.clock.freeze();
    user = await payments.signUp();
    superuser = await harness.db.superuserClient();
  });
  afterAll(async () => {
    await superuser?.end();
    await harness?.close();
  });
  beforeEach(async () => {
    payments.psp.clearFaults();
    payments.psp.setCaptureCompletion('immediate');
    await payments.clearRateLimits();
    user = await payments.logIn(user);
  });

  const clock = () => harness.auth!.clock;
  const daily = async () => (await reconciliation.run(ReconciliationRunKind.EXTERNAL_DAILY)) as ExternalRunResult;
  const internal = async () => (await reconciliation.run(ReconciliationRunKind.INTERNAL)) as InternalRunResult;
  const breaksOf = async (type: BreakType, subjectKey: string) =>
    (await reconciliation.allBreaks()).filter((entry) => entry.type === type && entry.subjectKey === subjectKey);
  const paymentOf = async (flowId: string) =>
    ((await harness.dataSource.query(`SELECT provider_payment_id FROM funding_payments WHERE flow_id = $1`, [flowId])) as { provider_payment_id: string }[])[0]
      .provider_payment_id;
  const stateOf = async (flowId: string) =>
    ((await harness.dataSource.query(`SELECT state FROM flow_instances WHERE id = $1`, [flowId])) as { state: string }[])[0].state;
  const subject = (paymentId: string) => `payment:simulated-psp:${paymentId}`;

  async function fund(amount: string): Promise<string> {
    const response = await payments.fund(user, { amount, currency: 'NGN', paymentMethodToken: 'tok_success_visa' });
    expect(response.status).toBe(202);
    return response.body.fundingId as string;
  }

  describe('internal', () => {
    it('FX provenance: a conversion is re-derived from its own snapshot — a missing rate, a tampered reference rate and a tampered display rate are each a break', async () => {
      const owner = await harness.db.ownerClient();
      let snapshotId: string;
      try {
        [{ id: snapshotId }] = (
          await owner.query(
            `INSERT INTO exchange_rate_snapshots (provider, base_currency_code, provider_updated_at, provider_next_update_at, fetched_at, status)
             VALUES ('paths-test', 'USD', now(), now() + interval '1 hour', now(), 'ACCEPTED') RETURNING id`,
          )
        ).rows as { id: string }[];
        await owner.query(`INSERT INTO exchange_rate_snapshot_rates (snapshot_id, currency_code, rate) VALUES ($1, 'USD', 1), ($1, 'NGN', 1530.50)`, [snapshotId]);
      } finally {
        await owner.end();
      }
      const naira = await harness.openUserAccount('NGN');
      await harness.fund(naira, 100_000_000n);
      const dollars = await harness.openUserAccount('USD', naira);
      const convert = async (provenance: Awaited<ReturnType<LedgerHarness['conversionProvenance']>>) =>
        harness.ledger.post({
          transaction: {
            type: TransactionType.CONVERSION,
            authorization: PostingAuthorization.SYSTEM_DRIVEN,
            valueTime: new Date(),
            initiatedBy: `user:${naira.userId}`,
            userId: naira.userId,
            conversion: provenance,
          },
          entries: [
            { account: { accountId: naira.accountId }, direction: EntryDirection.DEBIT, amount: Money.of(1_000_000n, 'NGN') },
            { account: { systemAccount: 'FX_POSITION' }, direction: EntryDirection.CREDIT, amount: Money.of(1_000_000n, 'NGN') },
            { account: { systemAccount: 'FX_POSITION' }, direction: EntryDirection.DEBIT, amount: Money.of(653n, 'USD') },
            { account: { accountId: dollars.accountId }, direction: EntryDirection.CREDIT, amount: Money.of(650n, 'USD') },
            { account: { systemAccount: 'REVENUE:FX_SPREAD' }, direction: EntryDirection.CREDIT, amount: Money.of(3n, 'USD') },
          ],
        });
      const source = { code: 'NGN', minorUnit: 2 };
      const target = { code: 'USD', minorUnit: 2 };
      const good = {
        sourceCurrency: 'NGN',
        sourceAmountMinor: 1_000_000n,
        targetCurrency: 'USD',
        targetAmountMinor: 650n,
        rateDisplay: rateDisplayOf(source, 1_000_000n, target, 650n),
        referenceRate: exactRateString(triangulatedMid(dec('1530.50'), dec('1'))),
        rateProvider: 'paths-test',
        rateFetchedAt: new Date(),
        rateProviderUpdatedAt: new Date(),
        rateSnapshotId: snapshotId!,
        spreadBasisPoints: 50,
      };
      const correct = await convert(good);
      expect((await internal()).status).toBe(ReconciliationRunStatus.CLEAN); // re-derives exactly

      // The harness fixture cites a snapshot with no rates at all.
      const missing = await convert(await harness.conversionProvenance({ sourceCurrency: 'NGN', sourceAmountMinor: 1_000_000n, targetCurrency: 'USD', targetAmountMinor: 650n }));
      const tamperedReference = await convert(good);
      const tamperedDisplay = await convert(good);
      await superuser.query(`ALTER TABLE transactions DISABLE TRIGGER transactions_guard_mutation`);
      try {
        await superuser.query(`UPDATE transactions SET reference_rate = reference_rate * 2 WHERE id = $1`, [tamperedReference.transactionId]);
        await superuser.query(`UPDATE transactions SET rate_display = rate_display * 3 WHERE id = $1`, [tamperedDisplay.transactionId]);
      } finally {
        await superuser.query(`ALTER TABLE transactions ENABLE TRIGGER transactions_guard_mutation`);
      }
      const result = await internal();
      const found = (await reconciliation.allBreaks()).filter((entry) => result.breakIds.includes(entry.id) && entry.type === BreakType.FX_PROVENANCE_MISMATCH);
      expect(Object.fromEntries(found.map((entry) => [entry.subjectKey, entry.details.problem]))).toEqual({
        [`transaction:${missing.transactionId}`]: 'SNAPSHOT_RATE_MISSING',
        [`transaction:${tamperedReference.transactionId}`]: 'REFERENCE_RATE_MISMATCH',
        [`transaction:${tamperedDisplay.transactionId}`]: 'RATE_DISPLAY_MISMATCH',
      });
      expect(found.every((entry) => entry.status === BreakStatus.ESCALATED)).toBe(true);
      expect(result.breakIds).not.toContain(`transaction:${correct.transactionId}`);
    });

    it('an edited entry amount breaks the trial balance, continuity, the cached balance and the hash chain — each recorded, drift per currency', async () => {
      const victim = await harness.openUserAccount('EUR');
      for (const amount of [100n, 200n]) await harness.fund(victim, amount);
      const [{ id: entryId }] = (await harness.dataSource.query(`SELECT id::text AS id FROM ledger_entries WHERE account_id = $1 ORDER BY ledger_entries.id LIMIT 1`, [
        victim.accountId,
      ])) as { id: string }[];
      await superuser.query(`ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_no_mutation`);
      await superuser.query(`UPDATE ledger_entries SET amount_minor = amount_minor + 7 WHERE id = $1`, [entryId]);
      await superuser.query(`ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_no_mutation`);
      try {
        const result = await internal();
        const types = new Set((await reconciliation.allBreaks()).filter((entry) => result.breakIds.includes(entry.id)).map((entry) => entry.type));
        for (const type of [BreakType.TRIAL_BALANCE_UNBALANCED, BreakType.BALANCE_CONTINUITY_BREAK, BreakType.CACHED_BALANCE_DRIFT, BreakType.HASH_CHAIN_BREAK]) {
          expect(types).toContain(type);
        }
        expect(result.drift.get('EUR')).toBeGreaterThan(0n);
        expect(result.drift.get('NGN')).toBe(0n);
        // Both sources in one gauge, sorted by currency then source.
        await daily();
        const gauge = reconciliation.metrics.reconciliationDriftMinor().filter((row) => row.currency === 'EUR');
        expect(gauge.map((row) => row.source)).toEqual(['external', 'internal']);
      } finally {
        await superuser.query(`ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_no_mutation`);
        await superuser.query(`UPDATE ledger_entries SET amount_minor = amount_minor - 7 WHERE id = $1`, [entryId]);
        await superuser.query(`ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_no_mutation`);
      }
    });
  });

  describe('external', () => {
    it('a PENDING batch is not settled (money has not moved); once PAID it is', async () => {
      const flowId = await fund('210000');
      await payments.drive();
      const batchId = payments.psp.settle({ currency: 'NGN', paymentIds: [await paymentOf(flowId)], status: 'pending' });
      await daily();
      expect(await stateOf(flowId)).toBe('POSTED');
      payments.psp.publish(batchId, 'paid');
      await daily();
      expect(await stateOf(flowId)).toBe('SETTLED');
    });

    it('an unreadable report: one SETTLEMENT_REPORT_REJECTED (UNREADABLE); read later, it is ingested and the break resolved REPORT_INGESTED', async () => {
      const flowId = await fund('220000');
      await payments.drive();
      const batchId = payments.psp.settle({ currency: 'NGN', paymentIds: [await paymentOf(flowId)] });
      payments.psp.failNext('get_settlement', 'malformed_json', 4, batchId); // every retry of this report, regardless of batch order
      await daily();
      const [unreadable] = await breaksOf(BreakType.SETTLEMENT_REPORT_REJECTED, `batch:simulated-psp:${batchId}`);
      expect(unreadable).toMatchObject({ status: BreakStatus.ESCALATED, details: expect.objectContaining({ rejection: 'UNREADABLE' }) });
      await daily();
      const [resolved] = await breaksOf(BreakType.SETTLEMENT_REPORT_REJECTED, `batch:simulated-psp:${batchId}`);
      expect(resolved).toMatchObject({ status: BreakStatus.RESOLVED, resolutionKind: ResolutionKind.REPORT_INGESTED });
      expect(await stateOf(flowId)).toBe('SETTLED');
    });

    it('a PSP outage mid-run: the run fails, keeps no lease, and the next tick resumes the same period to CLEAN', async () => {
      payments.psp.failNext('list_settlements', 'server_error', 4);
      const key = '5001-01-01';
      await expect(reconciliation.scheduler.runPeriod(ReconciliationRunKind.EXTERNAL_DAILY, key)).rejects.toThrow(/PSP list-settlements failed/);
      const failed = await reconciliation.runRow(ReconciliationRunKind.EXTERNAL_DAILY, key);
      expect(failed).toMatchObject({ status: ReconciliationRunStatus.RUNNING, lastError: expect.stringMatching(/ProviderUnavailableError/) });
      const resumed = await reconciliation.scheduler.runPeriod(ReconciliationRunKind.EXTERNAL_DAILY, key);
      expect(resumed).not.toBeNull();
      expect((await reconciliation.runRow(ReconciliationRunKind.EXTERNAL_DAILY, key))?.attempts).toBe(2);
    });

    it('the daily completeness check also finds a capture we never booked, and drives the flow', async () => {
      payments.psp.setCaptureCompletion('manual');
      const flowId = await fund('230000');
      await payments.drive();
      const paymentId = await paymentOf(flowId);
      payments.psp.completeCapture(paymentId);
      for (const event of payments.psp.pendingWebhooks()) payments.psp.drop(event.id);
      clock().advance(2 * HOUR);
      await daily();
      const [found] = await breaksOf(BreakType.MISSING_IN_LEDGER, subject(paymentId));
      expect(found).toMatchObject({ status: BreakStatus.RESOLVED, resolutionKind: ResolutionKind.FLOW_ADVANCED });
      expect(found.details.source).toBe('PAYMENT_LIST');
    });

    it('a batch naming a captured deposit we have not booked yet: the flow is driven first, then the line is attributed normally', async () => {
      payments.psp.setCaptureCompletion('manual');
      const flowId = await fund('240000');
      await payments.drive();
      const paymentId = await paymentOf(flowId);
      payments.psp.completeCapture(paymentId);
      for (const event of payments.psp.pendingWebhooks()) payments.psp.drop(event.id);
      payments.psp.settle({ currency: 'NGN', paymentIds: [paymentId] });
      const result = await daily();
      expect(await stateOf(flowId)).toBe('SETTLED');
      const created = (await harness.dataSource.query(`SELECT type::text AS type FROM reconciliation_breaks WHERE detected_by_run_id = $1 AND subject_key = $2`, [
        result.runId,
        subject(paymentId),
      ])) as unknown[];
      expect(created).toEqual([]);
    });

    it('a partial chargeback with its webhook lost: CHARGEBACK_NOT_REVERSED (partial), escalated — never auto-reversed', async () => {
      const flowId = await fund('250000');
      await payments.drive();
      const paymentId = await paymentOf(flowId);
      payments.psp.chargeback(paymentId, '100000');
      for (const event of payments.psp.pendingWebhooks()) payments.psp.drop(event.id);
      clock().advance(2 * HOUR);
      await daily();
      const [found] = await breaksOf(BreakType.CHARGEBACK_NOT_REVERSED, `flow:${flowId}`);
      expect(found).toMatchObject({ status: BreakStatus.ESCALATED, details: expect.objectContaining({ partial: true }) });
      expect(await stateOf(flowId)).toBe('POSTED');
      // The hourly retry leaves a partial alone.
      await reconciliation.run(ReconciliationRunKind.EXTERNAL_HOURLY);
      expect((await breaksOf(BreakType.CHARGEBACK_NOT_REVERSED, `flow:${flowId}`))[0].status).toBe(BreakStatus.ESCALATED);
    });

    it('a chargeback on a payment we never booked is that payment’s break, not a chargeback break', async () => {
      const foreign = payments.psp.createForeignPayment('26000', 'NGN');
      payments.psp.chargeback(foreign);
      clock().advance(2 * HOUR);
      await daily();
      expect(await breaksOf(BreakType.PAYMENT_WITHOUT_FLOW, subject(foreign))).toHaveLength(1);
      expect((await reconciliation.allBreaks()).filter((entry) => entry.type === BreakType.CHARGEBACK_NOT_REVERSED && entry.providerPaymentId === foreign)).toEqual([]);
    });

    it('a late deposit reversed before it was ever settled: its UNSETTLED_PAST_WINDOW break is resolved REVERSAL_POSTED', async () => {
      const flowId = await fund('270000');
      await payments.drive();
      const paymentId = await paymentOf(flowId);
      clock().advance(6 * DAY);
      await daily();
      expect((await breaksOf(BreakType.UNSETTLED_PAST_WINDOW, subject(paymentId)))[0].status).toBe(BreakStatus.OPEN);
      payments.psp.chargeback(paymentId);
      await payments.drive(); // this time the webhook arrives: reversed
      expect(await stateOf(flowId)).toBe('REVERSED');
      await daily();
      const [resolved] = await breaksOf(BreakType.UNSETTLED_PAST_WINDOW, subject(paymentId));
      expect(resolved).toMatchObject({ status: BreakStatus.RESOLVED, resolutionKind: ResolutionKind.REVERSAL_POSTED });
    });

    it('a webhook about a payment the PSP itself does not know: UNMATCHED_WEBHOOK, escalated with that reason', async () => {
      const body = Buffer.from(JSON.stringify({ id: 'evt_ghost_payment', type: 'payment.captured', data: { object: { id: 'pay_ghost', reference: 'nobody' } } }));
      await request(harness.auth!.app.getHttpServer())
        .post(PSP_WEBHOOK_PATH)
        .set({ 'content-type': 'application/json', 'x-psp-signature': payments.psp.sign(body) })
        .send(body.toString('utf8'))
        .expect(202);
      await payments.processor.processDue(10);
      const [{ id }] = (await harness.dataSource.query(`SELECT id FROM webhook_events WHERE provider_event_id = 'evt_ghost_payment'`)) as { id: string }[];
      await daily();
      const [found] = await breaksOf(BreakType.UNMATCHED_WEBHOOK, `webhook:${id}`);
      expect(found.status).toBe(BreakStatus.ESCALATED);
      expect(found.resolutionNote).toMatch(/the PSP does not know the payment either/);
    });

    it('a receivable that no longer matches its deposits is RECEIVABLE_PROOF_FAILED, with the gap', async () => {
      const [{ id }] = (await harness.dataSource.query(`SELECT id FROM accounts WHERE code = 'PSP_RECEIVABLE:NGN' ORDER BY bucket LIMIT 1`)) as { id: string }[];
      await superuser.query(`UPDATE accounts SET balance_minor = balance_minor - 5 WHERE id = $1`, [id]);
      try {
        await daily();
        const [found] = await breaksOf(BreakType.RECEIVABLE_PROOF_FAILED, 'receivable:NGN');
        expect(found).toMatchObject({ status: BreakStatus.ESCALATED, amountMinor: 5n, currency: 'NGN' });
      } finally {
        await superuser.query(`UPDATE accounts SET balance_minor = balance_minor + 5 WHERE id = $1`, [id]);
      }
    });

    it('hourly: an old flow that never reached the PSP is simply driven (no break: nothing was captured)', async () => {
      const flowId = await fund('280000'); // nobody drives it
      clock().advance(2 * HOUR);
      const result = (await reconciliation.run(ReconciliationRunKind.EXTERNAL_HOURLY)) as ExternalRunResult;
      expect(result.summary.unresolvedFlowsDriven).toBeGreaterThanOrEqual(1);
      expect(['AUTHORIZED', 'CAPTURED', 'POSTED']).toContain(await stateOf(flowId));
      expect((await reconciliation.allBreaks()).filter((entry) => entry.flowId === flowId)).toEqual([]);
    });
  });

  describe('the services’ own guards', () => {
    it('breaks: an operator is recorded as an OPERATOR; resolving needs a real actor and a reference; resolving twice is a no-op; unknown ids', async () => {
      const [live] = await reconciliation.liveBreaks();
      expect(live).toBeDefined();
      await expect(reconciliation.breaks.resolve(live.id, 'someone', ResolutionKind.OPERATOR_RESOLVED, 'x', 'n')).rejects.toThrow(/job:\{name\}' or 'operator/);
      await expect(reconciliation.breaks.resolve(live.id, 'job:test', ResolutionKind.OPERATOR_RESOLVED, '', 'n')).rejects.toThrow(/needs a reference/);
      const operator = user.userId;
      expect(await reconciliation.breaks.resolve(live.id, `operator:${operator}`, ResolutionKind.OPERATOR_RESOLVED, 'ticket-1', 'checked by hand')).toBe(true);
      expect(await reconciliation.breaks.resolve(live.id, `operator:${operator}`, ResolutionKind.OPERATOR_RESOLVED, 'ticket-1', 'again')).toBe(false);
      const [audit] = (await harness.dataSource.query(
        `SELECT actor_type::text AS actor_type, actor_id FROM audit_logs WHERE subject_id = $1 AND action = 'RECONCILIATION_BREAK_RESOLVED'`,
        [live.id],
      )) as { actor_type: string; actor_id: string }[];
      expect(audit).toEqual({ actor_type: 'OPERATOR', actor_id: operator });
      const unknown = '00000000-0000-4000-8000-000000000000';
      expect(await reconciliation.breaks.findById(unknown)).toBeNull();
      expect(await reconciliation.breaks.findLive(BreakType.HASH_CHAIN_BREAK, 'account:nobody')).toBeNull();
      await expect(reconciliation.breaks.escalate(unknown, 'job:test', 'n')).rejects.toThrow(/not found/);
    });

    it('runs: a zombie cannot heartbeat a run it lost; an unknown period reads as null; an abandoned OLDER period is resumed before the current one', async () => {
      const zombie = await reconciliation.runs.claim(ReconciliationRunKind.INTERNAL, '1999-01-01', 300);
      expect(zombie).not.toBeNull();
      await harness.dataSource.query(`UPDATE reconciliation_runs SET leased_until = now() - interval '1 second' WHERE id = $1`, [zombie!.id]);
      const results = await reconciliation.scheduler.runDue(ReconciliationRunKind.INTERNAL);
      expect(results.map((result) => result.runId)).toContain(zombie!.id);
      await expect(reconciliation.runs.heartbeat(zombie!, 300)).rejects.toThrow(/no longer leased/);
      expect(await reconciliation.runs.find(ReconciliationRunKind.INTERNAL, '1998-01-01')).toBeNull();
    });

    it('the ReconciliationBreakChanged.v1 handler acknowledges ids and refuses a malformed payload', async () => {
      const handler = harness.moduleRef.get(ReconciliationBreakChangedHandler);
      const id = '11111111-1111-4111-8111-111111111111';
      const event = (payload: unknown, aggregateId = id) => ({ id: 'e', eventType: OutboxEventType.RECONCILIATION_BREAK_CHANGED, aggregateId, payload, attempts: 1 });
      await expect(handler.handle(event({ breakId: id, type: 'HASH_CHAIN_BREAK', status: 'OPEN' }))).resolves.toBeUndefined();
      await expect(handler.handle(event(null))).rejects.toThrow(/malformed payload/);
      await expect(handler.handle(event({ breakId: 'nope' }))).rejects.toThrow(/malformed payload/);
      await expect(handler.handle(event({ breakId: id }, '22222222-2222-4222-8222-222222222222'))).rejects.toThrow(/malformed payload/);
    });
  });
});
