import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { bootstrapAdministrators } from '../../scripts/bootstrap-administrators';
import { API_PREFIX } from '../../src/app.setup';
import { loadConfig } from '../../src/config/configuration';
import { buildDataSourceOptions } from '../../src/database/data-source.options';
import { ReconciliationRunKind } from '../../src/modules/reconciliation/reconciliation-schedule';
import { HARNESS_USER_PASSWORD, LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

const DAY = 24 * 3600 * 1000;

/**
 * Controls, end to end (Phase 10 plan §H): the first ADMIN and SECURITY officer are bootstrapped by the real CLI
 * function over the owner's connection; the ADMIN grants a second ADMIN through an approval SECURITY decides; a
 * customer's funding lands in CLEARING through a settlement fault (the PSP settles less than it captured);
 * reconciliation escalates it; one admin requests the correction, the other approves; the customer's balance and
 * history show it, the break is resolved citing the approval, and the audit trail links every step. No PII, no
 * secret in any log line.
 */
describe('admin controls (e2e)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  const logLines: string[] = [];

  const http = () => request(harness.auth!.app.getHttpServer());
  const as = (user: SignedUpUser) => ({
    get: (path: string) => http().get(`/${API_PREFIX}${path}`).set('Authorization', `Bearer ${user.accessToken}`),
    post: (path: string, body: object = {}) =>
      http().post(`/${API_PREFIX}${path}`).set('Authorization', `Bearer ${user.accessToken}`).set('Idempotency-Key', randomUUID()).send(body),
  });

  beforeAll(async () => {
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logLines.push(...chunk.toString('utf8').split('\n').filter((line) => line.length > 0));
        callback();
      },
    });
    harness = await startLedgerHarness({ LOG_LEVEL: 'info' }, { payments: true, logStream });
    payments = harness.payments!;
    harness.auth!.clock.freeze();
  }, 180_000);

  afterAll(async () => harness?.close());

  it('bootstrap → a second admin by approval → a CLEARING correction by two people → balance, history, break, trail; clean logs', async () => {
    const [firstAdmin, security, secondAdmin, customer] = [await payments.signUp(), await payments.signUp(), await payments.signUp(), await payments.signUp()];

    // 1. The one-time bootstrap, through the CLI's own function, over the OWNER's connection.
    const owner = new DataSource(buildDataSourceOptions(loadConfig(harness.db.env).db, 'migration'));
    await owner.initialize();
    try {
      await bootstrapAdministrators(owner, firstAdmin.userId, security.userId);
      await expect(bootstrapAdministrators(owner, secondAdmin.userId, customer.userId)).rejects.toThrow(/already bootstrapped/);
    } finally {
      await owner.destroy();
    }

    // 2. The first admin grants a second through an approval; SECURITY decides; it works on the next request.
    expect((await as(secondAdmin).get('/admin/positions')).status).toBe(403);
    const grant = await as(firstAdmin).post('/admin/approvals', {
      actionType: 'ROLE_CHANGE',
      payload: { userId: secondAdmin.userId, role: 'ADMIN', operation: 'GRANT' },
      reason: 'second treasury operator (four-eyes needs two)',
    });
    expect(grant.status).toBe(201);
    expect((await as(firstAdmin).post(`/admin/approvals/${grant.body.approvalId as string}/approve`)).body.code).toBe('SELF_APPROVAL_FORBIDDEN');
    const granted = await as(security).post(`/admin/approvals/${grant.body.approvalId as string}/approve`);
    expect(granted.body).toMatchObject({ status: 'EXECUTED', approvedBy: security.userId });
    expect((await as(secondAdmin).get('/admin/positions')).status).toBe(200);

    // 3. The customer funds; the PSP settles LESS than it captured: the line lands in CLEARING, escalated.
    const funded = await as(customer).post('/wallet/fund', { amount: '250000', currency: 'NGN', paymentMethodToken: 'tok_success_visa' });
    expect(funded.status).toBe(202);
    await payments.drive();
    const [deposit] = (await harness.dataSource.query(`SELECT provider_payment_id FROM funding_payments WHERE flow_id = $1`, [funded.body.fundingId])) as {
      provider_payment_id: string;
    }[];
    harness.auth!.clock.advance(3 * DAY);
    payments.psp.settle({ currency: 'NGN', paymentIds: [deposit!.provider_payment_id], alterAmounts: { [deposit!.provider_payment_id]: -2_500n } });
    await payments.reconciliation.run(ReconciliationRunKind.EXTERNAL_DAILY);
    const [a, s, b, c] = [await payments.logIn(firstAdmin), await payments.logIn(security), await payments.logIn(secondAdmin), await payments.logIn(customer)];
    const breaks = await as(b).get('/admin/breaks?status=LIVE&type=AMOUNT_MISMATCH');
    expect(breaks.body.items).toHaveLength(1);
    const broken = breaks.body.items[0] as { breakId: string; status: string; severity: string };
    expect(broken).toMatchObject({ status: 'ESCALATED', severity: 'MONEY' });
    const balanceBefore = ((await as(c).get('/wallet')).body.balances as { currency: string; total: string }[]).find((line) => line.currency === 'NGN')!.total;

    // 4. One admin requests the correction; the other approves.
    const requested = await as(a).post('/admin/approvals', {
      actionType: 'CORRECTION',
      payload: { mode: 'SETTLE_DEPOSIT_FROM_CLEARING', breakId: broken.breakId, valueTime: new Date(Date.now() - 1000).toISOString() },
      reason: 'PSP settled ₦25 less than captured: their truth wins',
    });
    expect(requested.status).toBe(201);
    const executed = await as(b).post(`/admin/approvals/${requested.body.approvalId as string}/approve`);
    expect(executed.body).toMatchObject({ status: 'EXECUTED', requestedBy: firstAdmin.userId, approvedBy: secondAdmin.userId });
    const approvalId = executed.body.approvalId as string;

    // 5. The customer's balance and history show it.
    const balanceAfter = ((await as(c).get('/wallet')).body.balances as { currency: string; total: string }[]).find((line) => line.currency === 'NGN')!.total;
    expect(BigInt(balanceAfter) - BigInt(balanceBefore)).toBe(-2_500n);
    const item = await as(c).get(`/transactions/approval:${approvalId}`);
    expect(item.body).toMatchObject({ type: 'CORRECTION', reasonCode: 'SETTLEMENT_AMOUNT_CORRECTION', initiatedBy: 'OPERATOR', corrects: { type: 'FUNDING' } });
    const funding = await as(c).get(`/transactions/funding:${funded.body.fundingId as string}`);
    expect(funding.body.correctedBy).toMatchObject({ reference: `approval:${approvalId}`, type: 'CORRECTION' });

    // 6. The break is resolved citing the approval; the trail links break → approval → posting → resolution.
    const detail = await as(s).get(`/admin/breaks/${broken.breakId}`);
    expect(detail.body).toMatchObject({ status: 'RESOLVED', resolutionKind: 'CORRECTION_POSTED', resolutionReference: `approval:${approvalId}`, resolvedBy: `operator:${secondAdmin.userId}` });
    expect(detail.body.approvals.map((approval: { approvalId: string }) => approval.approvalId)).toContain(approvalId);
    const trail = ((await as(s).get(`/admin/approvals/${approvalId}`)).body.trail as { action: string; actorId: string | null }[]).map((entry) => entry.action);
    expect(trail).toEqual(
      expect.arrayContaining([
        'RECONCILIATION_BREAK_DETECTED',
        'APPROVAL_REQUESTED',
        'APPROVAL_APPROVED',
        'CORRECTION_POSTED',
        'RECONCILIATION_BREAK_RESOLVED',
        'APPROVAL_EXECUTED',
      ]),
    );
    expect(trail.indexOf('APPROVAL_REQUESTED')).toBeLessThan(trail.indexOf('APPROVAL_EXECUTED'));
    const report = await as(s).get('/admin/recertification');
    expect(report.body.holders).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: secondAdmin.userId, role: 'ADMIN', grantedBy: security.userId, grantApprovalId: grant.body.approvalId })]),
    );
    const health = await http().get(`/${API_PREFIX}/health/live`);
    expect(health.body.version).toEqual({ gitSha: expect.any(String) });
    await harness.expectCleanBooks();

    // 7. Log hygiene: no email, no password, no token anywhere in what the app logged.
    const everything = logLines.join('\n');
    expect(logLines.length).toBeGreaterThan(0);
    for (const secret of [firstAdmin.email, security.email, secondAdmin.email, customer.email, HARNESS_USER_PASSWORD, a.accessToken, b.accessToken, c.accessToken]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).toContain(approvalId); // ids are logged — that is the point
  });
});
