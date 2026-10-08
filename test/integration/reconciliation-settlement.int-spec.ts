import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { ExternalRunResult } from '../../src/modules/reconciliation/external-reconciliation.job';
import { ReconciliationRunStatus } from '../../src/modules/reconciliation/reconciliation-run.repository';
import { ReconciliationRunKind } from '../../src/modules/reconciliation/reconciliation-schedule';
import { HARNESS_USER_PASSWORD, LedgerHarness, PaymentsHarness, ReconciliationHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

const DAY = 24 * 3600 * 1000;

/**
 * Settlement (Phase 9): the PSP pays out captured deposits in one batch at T+X; the external
 * run posts ONE settlement (DR BANK net + DR EXPENSE:PSP_FEES / CR PSP_RECEIVABLE gross), moves
 * every settled flow POSTED → SETTLED, and finds nothing wrong. Asserted against the rows.
 */
describe('reconciliation: settlement (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let reconciliation: ReconciliationHarness;
  let user: SignedUpUser;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { payments: true });
    payments = harness.payments!;
    reconciliation = payments.reconciliation;
    user = await payments.signUp();
  });
  afterAll(async () => harness?.close());

  async function fund(amount: string, currency = 'NGN'): Promise<string> {
    const response = await payments.fund(user, { amount, currency, paymentMethodToken: 'tok_success_visa' });
    expect(response.status).toBe(202);
    return (response.body as { fundingId: string }).fundingId;
  }

  const depositOf = async (flowId: string) =>
    (
      (await harness.dataSource.query(
        `SELECT flow_instances.state, funding_payments.provider_payment_id, funding_payments.amount_minor::text AS amount_minor,
                funding_payments.settled_at, funding_payments.settlement_fee_minor::text AS settlement_fee_minor,
                funding_payments.settlement_batch_line_id
           FROM funding_payments JOIN flow_instances ON flow_instances.id = funding_payments.flow_id
          WHERE funding_payments.flow_id = $1`,
        [flowId],
      )) as {
        state: string;
        provider_payment_id: string;
        amount_minor: string;
        settled_at: Date | null;
        settlement_fee_minor: string | null;
        settlement_batch_line_id: string | null;
      }[]
    )[0];

  const internalTotal = async (template: string, currency: string) =>
    BigInt(
      (
        (await harness.dataSource.query(
          `SELECT coalesce(sum(balance_minor), 0)::text AS total FROM accounts WHERE code = $1 AND wallet_id IS NULL`,
          [`${template}:${currency}`],
        )) as { total: string }[]
      )[0].total,
    );

  const newBreaksOf = async (runId: string) =>
    (await harness.dataSource.query(`SELECT type::text AS type FROM reconciliation_breaks WHERE detected_by_run_id = $1 ORDER BY type`, [
      runId,
    ])) as { type: string }[];

  it('clean path: N deposits, one batch at T+X → one posting, every flow SETTLED, receivable = what is unsettled, zero breaks', async () => {
    const flowIds = [await fund('150000'), await fund('250000'), await fund('1000000')];
    await payments.drive();
    for (const flowId of flowIds) expect((await depositOf(flowId)).state).toBe('POSTED');

    const receivableBefore = await internalTotal('PSP_RECEIVABLE', 'NGN');
    const bankBefore = await internalTotal('BANK', 'NGN');
    const feesBefore = await internalTotal('EXPENSE:PSP_FEES', 'NGN');

    // T+2: the PSP pays them out in one batch.
    payments.psp.setPageSize(2); // the report's lines and the lists paginate
    harness.auth!.clock.advance(2 * DAY);
    const batchId = payments.psp.settle({ currency: 'NGN', paymentIds: await Promise.all(flowIds.map(async (id) => (await depositOf(id)).provider_payment_id)) });
    const report = payments.psp.report(batchId) as { gross: string; fees: string; net: string };

    const result = (await reconciliation.run(ReconciliationRunKind.EXTERNAL_DAILY)) as ExternalRunResult;
    expect(result.status).toBe(ReconciliationRunStatus.CLEAN);
    expect(await newBreaksOf(result.runId)).toEqual([]);

    // One settlement posting for the batch, no user, value time = the PSP's settlement time.
    const settlements = (await harness.dataSource.query(
      `SELECT id, user_id, type, reference, external_reference, value_time, settlement_time FROM transactions WHERE type = 'SETTLEMENT' AND external_reference = $1`,
      [batchId],
    )) as { id: string; user_id: string | null; reference: string; value_time: Date; settlement_time: Date }[];
    expect(settlements).toHaveLength(1);
    expect(settlements[0].user_id).toBeNull();
    expect(settlements[0].reference).toBe(`settlement:simulated-psp:${batchId}`);
    expect(settlements[0].settlement_time.getTime()).toBe(settlements[0].value_time.getTime());

    // Every flow SETTLED with the batch line, its fee and the settlement time.
    let gross = 0n;
    let fees = 0n;
    for (const flowId of flowIds) {
      const deposit = await depositOf(flowId);
      expect(deposit.state).toBe('SETTLED');
      expect(deposit.settled_at?.getTime()).toBe(settlements[0].settlement_time.getTime());
      expect(deposit.settlement_batch_line_id).not.toBeNull();
      gross += BigInt(deposit.amount_minor);
      fees += BigInt(deposit.settlement_fee_minor!);
    }
    expect(gross.toString()).toBe(report.gross);
    expect(fees.toString()).toBe(report.fees);

    // BANK + fees = gross; the receivable went down by exactly the gross.
    expect((await internalTotal('BANK', 'NGN')) - bankBefore).toBe(BigInt(report.net));
    expect((await internalTotal('EXPENSE:PSP_FEES', 'NGN')) - feesBefore).toBe(fees);
    expect(receivableBefore - (await internalTotal('PSP_RECEIVABLE', 'NGN'))).toBe(gross);
    const unsettled = (await harness.dataSource.query(
      `SELECT coalesce(sum(amount_minor), 0)::text AS total FROM funding_payments
        WHERE currency_code = 'NGN' AND funding_transaction_id IS NOT NULL AND settlement_batch_line_id IS NULL AND chargeback_transaction_id IS NULL`,
    )) as { total: string }[];
    expect(await internalTotal('PSP_RECEIVABLE', 'NGN')).toBe(BigInt(unsettled[0].total));
    await harness.expectCleanBooks();

    // Re-running changes nothing: no second posting, no break.
    const again = (await reconciliation.run(ReconciliationRunKind.EXTERNAL_DAILY)) as ExternalRunResult;
    expect(again.status).toBe(ReconciliationRunStatus.CLEAN);
    const [{ count }] = (await harness.dataSource.query(`SELECT count(*)::int AS count FROM transactions WHERE type = 'SETTLEMENT'`)) as { count: number }[];
    expect(count).toBe(1);

    // History shows the settlement time on the funding; the settlement itself is in nobody's history.
    // (The clock moved days: the access token expired — log in again.)
    const login = await request(harness.auth!.app.getHttpServer())
      .post(`/${API_PREFIX}/auth/login`)
      .send({ email: user.email, password: HARNESS_USER_PASSWORD })
      .expect(200);
    user = { ...user, accessToken: (login.body as { tokens: { access: { token: string } } }).tokens.access.token };
    const detail = await request(harness.auth!.app.getHttpServer())
      .get(`/${API_PREFIX}/transactions/funding:${flowIds[0]}`)
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.settlementTime).toBe(settlements[0].settlement_time.toISOString());
    expect(detail.body.status).toBe('COMPLETED');
    const list = await request(harness.auth!.app.getHttpServer())
      .get(`/${API_PREFIX}/transactions?limit=100`)
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect((list.body.items as { type: string }[]).map((item) => item.type)).not.toContain('SETTLEMENT');

    // The internal run agrees: clean.
    const internal = await reconciliation.run(ReconciliationRunKind.INTERNAL);
    expect(internal.status).toBe(ReconciliationRunStatus.CLEAN);
  });
});
