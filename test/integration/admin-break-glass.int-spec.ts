import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { Administrators, AdminHarness, LedgerHarness, PaymentsHarness, startLedgerHarness } from '../support/ledger-harness';

/**
 * Break-glass (design §9.2 "an explicit, documented single-actor override that pages the security channel
 * immediately and is reviewed within 24 hours"; Phase 10 plan §E.7): one actor, flagged, paged — an outbox event,
 * a metric, an audit row — reviewed once by SECURITY; unreviewed past the window it is visible and pages again,
 * once.
 */
describe('Admin break-glass (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let admin: AdminHarness;
  let first: Administrators;

  const http = () => request(harness.auth!.app.getHttpServer());
  const events = async (type: string, approvalId: string) =>
    ((await harness.dataSource.query(`SELECT count(*)::int AS count FROM outbox_events WHERE event_type = $1 AND aggregate_id = $2`, [type, approvalId])) as {
      count: number;
    }[])[0]!.count;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { payments: true });
    payments = harness.payments!;
    admin = payments.admin;
    first = await admin.bootstrap();
  }, 180_000);

  afterAll(async () => harness?.close());

  beforeEach(async () => payments.clearRateLimits());

  it('a single actor suspends at once — flagged, no approver — and security is paged (event, metric, audit)', async () => {
    const target = await payments.signUp();
    const before = admin.metrics.breakGlassUsedTotal().find((row) => row.action === 'SUSPEND_USER')?.count ?? 0;
    const response = await admin.request(first.admin, { actionType: 'SUSPEND_USER', payload: { userId: target.userId }, reason: 'account takeover in progress', breakGlass: true });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: 'EXECUTED', breakGlass: true, approvedBy: null, executedBy: first.admin.userId, review: null });
    const id = response.body.approvalId as string;
    expect((await http().get(`/${API_PREFIX}/wallet`).set('Authorization', `Bearer ${target.accessToken}`)).status).toBe(401);

    expect(await events('BreakGlassUsed.v1', id)).toBe(1);
    expect(admin.metrics.breakGlassUsedTotal().find((row) => row.action === 'SUSPEND_USER')?.count).toBe(before + 1);
    const [audited] = (await harness.dataSource.query(`SELECT actor_id::text AS actor FROM audit_logs WHERE subject_id = $1 AND action = 'BREAK_GLASS_USED'`, [id])) as {
      actor: string;
    }[];
    expect(audited?.actor).toBe(first.admin.userId);
    await harness.auth!.deliverOutbox(); // the page handler acknowledges (a later phase routes it)
    const [delivered] = (await harness.dataSource.query(`SELECT published_at IS NOT NULL AS done FROM outbox_events WHERE event_type = 'BreakGlassUsed.v1' AND aggregate_id = $1`, [
      id,
    ])) as { done: boolean }[];
    expect(delivered?.done).toBe(true);

    // The security queue shows it; SECURITY reviews it once; nobody else can.
    const queue = await admin.get(first.security, 'approvals?breakGlass=unreviewed');
    expect((queue.body as { items: { approvalId: string }[] }).items.map((item) => item.approvalId)).toContain(id);
    expect((await admin.decide(first.admin, id, 'review', { note: 'fine' })).status).toBe(403);
    const reviewed = await admin.decide(first.security, id, 'review', { note: 'confirmed takeover, correct call' });
    expect(reviewed.body.review).toMatchObject({ reviewedBy: first.security.userId, note: 'confirmed takeover, correct call' });
    expect((await admin.decide(first.security, id, 'review', { note: 'again' })).body.code).toBe('BREAK_GLASS_ALREADY_REVIEWED');
  });

  it('a break-glass use refused at execution (a manual rate beyond the single-actor cap) is still recorded, flagged and paged', async () => {
    const rows = (await harness.dataSource.query(`SELECT code FROM currencies WHERE is_active ORDER BY code`)) as { code: string }[];
    const rates = Object.fromEntries(rows.map((row) => [row.code.trim(), ({ USD: '1', NGN: '1500', EUR: '0.9', GBP: '0.78' } as Record<string, string>)[row.code.trim()] ?? '1']));
    const before = await harness.snapshot();
    const response = await admin.request(first.admin, {
      actionType: 'RATE_OVERRIDE',
      payload: { mode: 'MANUAL_RATE', rates, validForSeconds: 1_200 }, // ≤ 3,600 (four-eyes) but > 900 (break-glass)
      reason: 'providers down',
      breakGlass: true,
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: 'EXECUTION_FAILED', executionFailureCode: 'MANUAL_RATE_VALIDITY_TOO_LONG', breakGlass: true });
    expect(await events('BreakGlassUsed.v1', response.body.approvalId as string)).toBe(1);
    const [snapshots] = (await harness.dataSource.query(`SELECT count(*)::int AS count FROM exchange_rate_snapshots WHERE provider = 'manual'`)) as { count: number }[];
    expect(snapshots!.count).toBe(0);
    expect((await harness.snapshot()).transactionCount).toBe(before.transactionCount);
  });

  it('unreviewed past 24h: visible as overdue, paged again exactly once (event + audit), gauge set', async () => {
    const target = await payments.signUp();
    const id = (await admin.request(first.admin, { actionType: 'SUSPEND_USER', payload: { userId: target.userId }, reason: 'suspected fraud', breakGlass: true })).body
      .approvalId as string;
    await admin.monitor.tick();
    expect(admin.metrics.breakGlassUnreviewed.withinWindow).toBeGreaterThanOrEqual(1);
    expect(await events('BreakGlassReviewOverdue.v1', id)).toBe(0);

    const superuser = await harness.db.superuserClient();
    try {
      await superuser.query(`ALTER TABLE approvals DISABLE TRIGGER approvals_guard_mutation`);
      await superuser.query(`UPDATE approvals SET requested_at = now() - interval '25 hours', expires_at = now() + interval '1 day' WHERE id = $1`, [id]);
      await superuser.query(`ALTER TABLE approvals ENABLE TRIGGER approvals_guard_mutation`);
    } finally {
      await superuser.end();
    }
    expect((await admin.monitor.tick()).overdueAlerted).toBeGreaterThanOrEqual(1);
    expect(await events('BreakGlassReviewOverdue.v1', id)).toBe(1);
    expect(admin.metrics.breakGlassUnreviewed.overdue).toBeGreaterThanOrEqual(1);
    await admin.monitor.tick();
    expect(await events('BreakGlassReviewOverdue.v1', id)).toBe(1); // once
    const [audited] = (await harness.dataSource.query(`SELECT count(*)::int AS count FROM audit_logs WHERE subject_id = $1 AND action = 'BREAK_GLASS_REVIEW_OVERDUE'`, [id])) as {
      count: number;
    }[];
    expect(audited!.count).toBe(1);
  });
});
