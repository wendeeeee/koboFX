import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { Administrators, AdminHarness, LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

/**
 * Approvals and four-eyes over the real HTTP pipeline (design §9.2, §9.3, §12; Phase 10 plan §E.1–§E.3):
 * bootstrap once, role changes by approval (effective on the NEXT request), one decision per approval, the
 * requester never decides, expiry, cancel, reject, idempotent replay, and the trail of every step.
 */
describe('Admin approvals (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let admin: AdminHarness;
  let first: Administrators;
  let secondAdmin: SignedUpUser;

  const http = () => request(harness.auth!.app.getHttpServer());
  const suspend = (userId: string) => ({ actionType: 'SUSPEND_USER', payload: { userId }, reason: 'account takeover suspected (test)' });

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { payments: true });
    payments = harness.payments!;
    admin = payments.admin;
    first = await admin.bootstrap();
    secondAdmin = await admin.grant('ADMIN', first.admin, first.security);
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await payments.clearRateLimits();
  });

  describe('RBAC and the bootstrap', () => {
    it('the bootstrap cannot be repeated — not even with two fresh users', async () => {
      const [a, b] = [await payments.signUp(), await payments.signUp()];
      const owner = await harness.db.ownerClient();
      try {
        await expect(owner.query(`SELECT bootstrap_first_administrators($1, $2)`, [a.userId, b.userId])).rejects.toThrow(/already bootstrapped/);
      } finally {
        await owner.end();
      }
      const app = await harness.db.appClient();
      try {
        await expect(app.query(`SELECT bootstrap_first_administrators($1, $2)`, [a.userId, b.userId])).rejects.toThrow(/permission denied/);
      } finally {
        await app.end();
      }
    });

    it('a plain user gets 403 on every /admin route; an ADMIN reads; recertification is SECURITY-only', async () => {
      const user = await payments.signUp();
      for (const path of ['positions', 'breaks', 'reconciliation-runs', 'approvals', 'recertification', `users/${user.userId}`]) {
        expect((await admin.get(user, path)).status).toBe(403);
      }
      expect((await admin.request(user, suspend(first.admin.userId))).status).toBe(403);
      expect((await admin.get(first.admin, 'positions')).status).toBe(200);
      expect((await admin.get(first.admin, 'recertification')).status).toBe(403);
      const report = await admin.get(first.security, 'recertification');
      expect(report.status).toBe(200);
      const holders = (report.body as { holders: { userId: string; role: string; bootstrap: boolean; grantApprovalId: string | null }[] }).holders;
      expect(holders).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ userId: first.admin.userId, role: 'ADMIN', bootstrap: true, grantApprovalId: null }),
          expect.objectContaining({ userId: first.security.userId, role: 'SECURITY', bootstrap: true }),
          expect.objectContaining({ userId: secondAdmin.userId, role: 'ADMIN', bootstrap: false, grantApprovalId: expect.any(String) }),
        ]),
      );
      expect((report.body as { discrepancies: unknown[] }).discrepancies).toEqual([]);
    });

    it('a grant takes effect on the NEXT request with the same token; a revoke removes access on the next request', async () => {
      const user = await payments.signUp();
      expect((await admin.get(user, 'positions')).status).toBe(403);
      const granted = await admin.requestAndApprove(first.admin, first.security, {
        actionType: 'ROLE_CHANGE',
        payload: { userId: user.userId, role: 'ADMIN', operation: 'GRANT' },
        reason: 'new treasury operator',
      });
      expect(granted).toMatchObject({ status: 'EXECUTED', approvedBy: first.security.userId, executedBy: first.security.userId });
      expect((await admin.get(user, 'positions')).status).toBe(200); // same access token

      const revoked = await admin.requestAndApprove(first.admin, first.security, {
        actionType: 'ROLE_CHANGE',
        payload: { userId: user.userId, role: 'ADMIN', operation: 'REVOKE' },
        reason: 'left the team',
      });
      expect(revoked).toMatchObject({ status: 'EXECUTED' });
      expect((await admin.get(user, 'positions')).status).toBe(403); // same token, next request
      const [row] = (await harness.dataSource.query(
        `SELECT revoked_by::text, revoke_approval_id::text FROM role_assignments WHERE user_id = $1`,
        [user.userId],
      )) as { revoked_by: string; revoke_approval_id: string }[];
      expect(row).toEqual({ revoked_by: first.security.userId, revoke_approval_id: revoked.approvalId });
    });

    it('a role change is approved by SECURITY, never by an ADMIN; a security officer never requests one', async () => {
      const user = await payments.signUp();
      const requested = await admin.request(first.admin, { actionType: 'ROLE_CHANGE', payload: { userId: user.userId, role: 'ADMIN', operation: 'GRANT' }, reason: 'x' });
      expect(requested.status).toBe(201);
      const byAdmin = await admin.decide(secondAdmin, requested.body.approvalId as string, 'approve');
      expect(byAdmin.status).toBe(403);
      expect(byAdmin.body.code).toBe('FORBIDDEN');
      expect((await admin.request(first.security, { actionType: 'ROLE_CHANGE', payload: { userId: user.userId, role: 'ADMIN', operation: 'GRANT' }, reason: 'x' })).status).toBe(403);
    });

    it('refuses to revoke the last active SECURITY officer (409 LAST_ROLE_HOLDER); users.role moves only by approval', async () => {
      const refused = await admin.request(first.admin, {
        actionType: 'ROLE_CHANGE',
        payload: { userId: first.security.userId, role: 'SECURITY', operation: 'REVOKE' },
        reason: 'x',
      });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'ACTION_PRECONDITION_FAILED', details: { reason: 'LAST_ROLE_HOLDER' } });
      expect((await admin.get(first.security, 'recertification')).status).toBe(200);
      const app = await harness.db.appClient();
      const owner = await harness.db.ownerClient();
      try {
        await expect(app.query(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [randomUUID()])).rejects.toThrow(/permission denied/);
        await expect(owner.query(`UPDATE users SET role = 'USER' WHERE id = $1`, [secondAdmin.userId])).rejects.toThrow(/approved role change/);
      } finally {
        await app.end();
        await owner.end();
      }
    });
  });

  describe('four-eyes', () => {
    it('the requester cannot approve (403 SELF_APPROVAL_FORBIDDEN) nor reject their own request; another admin can', async () => {
      const target = await payments.signUp();
      const requested = await admin.request(first.admin, suspend(target.userId));
      expect(requested.status).toBe(201);
      expect(requested.body).toMatchObject({ status: 'PENDING', actionType: 'SUSPEND_USER', requestedBy: first.admin.userId, breakGlass: false });
      const id = requested.body.approvalId as string;
      for (const decision of ['approve', 'reject'] as const) {
        const own = await admin.decide(first.admin, id, decision, decision === 'reject' ? { reason: 'x' } : {});
        expect(own.status).toBe(403);
        expect(own.body.code).toBe('SELF_APPROVAL_FORBIDDEN');
      }
      const approved = await admin.decide(secondAdmin, id, 'approve');
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({ status: 'EXECUTED', approvedBy: secondAdmin.userId, resultReference: target.userId });
      // One decision per approval: a second one is refused, whoever tries.
      for (const [who, decision] of [[secondAdmin, 'approve'], [first.admin, 'cancel'], [secondAdmin, 'reject']] as const) {
        const again = await admin.decide(who, id, decision, decision === 'reject' ? { reason: 'x' } : {});
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('APPROVAL_ALREADY_DECIDED');
      }
      // The suspended user is out on the next request: their sessions were revoked with the suspension.
      expect((await http().get(`/${API_PREFIX}/wallet`).set('Authorization', `Bearer ${target.accessToken}`)).status).toBe(401);
      const [sessions] = (await harness.dataSource.query(
        `SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS live FROM refresh_token_families WHERE user_id = $1`,
        [target.userId],
      )) as { live: number }[];
      expect(sessions.live).toBe(0);
    });

    it('a retried approve (same Idempotency-Key) replays the outcome and executes once', async () => {
      const target = await payments.signUp();
      const id = (await admin.request(first.admin, suspend(target.userId))).body.approvalId as string;
      const key = randomUUID();
      const once = await admin.decide(secondAdmin, id, 'approve', {}, key);
      const twice = await admin.decide(secondAdmin, id, 'approve', {}, key);
      expect(once.status).toBe(200);
      expect(twice.status).toBe(200);
      expect(twice.headers['idempotent-replayed']).toBe('true');
      expect(twice.text).toBe(once.text);
      const [row] = (await harness.dataSource.query(
        `SELECT count(*)::int AS executions FROM audit_logs WHERE subject_id = $1 AND action = 'APPROVAL_EXECUTED'`,
        [id],
      )) as { executions: number }[];
      expect(row.executions).toBe(1);
    });

    it('reject records who and why; cancel is the requester\'s alone; both are final', async () => {
      const target = await payments.signUp();
      const rejectedId = (await admin.request(first.admin, suspend(target.userId))).body.approvalId as string;
      const rejected = await admin.decide(secondAdmin, rejectedId, 'reject', { reason: 'no evidence of takeover' });
      expect(rejected.body).toMatchObject({ status: 'REJECTED', rejectedBy: secondAdmin.userId, rejectionReason: 'no evidence of takeover' });

      const cancelledId = (await admin.request(first.admin, suspend(target.userId))).body.approvalId as string;
      expect((await admin.decide(secondAdmin, cancelledId, 'cancel')).status).toBe(403);
      const cancelled = await admin.decide(first.admin, cancelledId, 'cancel');
      expect(cancelled.body).toMatchObject({ status: 'CANCELLED' });
      expect((await admin.decide(secondAdmin, cancelledId, 'approve')).body.code).toBe('APPROVAL_ALREADY_DECIDED');
      expect((await http().get(`/${API_PREFIX}/wallet`).set('Authorization', `Bearer ${target.accessToken}`)).status).toBe(200);
    });

    it('an expired request is refused 409 APPROVAL_EXPIRED; the monitor records it EXPIRED (audited)', async () => {
      const target = await payments.signUp();
      const id = (await admin.request(first.admin, suspend(target.userId))).body.approvalId as string;
      const owner = await harness.db.superuserClient();
      try {
        // Time passes: the only way to age a row whose request is immutable is below the application.
        await owner.query(`ALTER TABLE approvals DISABLE TRIGGER approvals_guard_mutation`);
        await owner.query(`UPDATE approvals SET requested_at = now() - interval '4 days', expires_at = now() - interval '1 day' WHERE id = $1`, [id]);
        await owner.query(`ALTER TABLE approvals ENABLE TRIGGER approvals_guard_mutation`);
      } finally {
        await owner.end();
      }
      const late = await admin.decide(secondAdmin, id, 'approve');
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('APPROVAL_EXPIRED');
      expect(await admin.monitor.tick()).toMatchObject({ expired: 1 });
      expect((await admin.get(first.admin, `approvals/${id}`)).body).toMatchObject({ status: 'EXPIRED' });
    });

    it('an approval whose requester lost the role can no longer be approved (409 APPROVAL_REQUESTER_INELIGIBLE)', async () => {
      const temporary = await admin.grant('ADMIN', first.admin, first.security);
      const target = await payments.signUp();
      const id = (await admin.request(temporary, suspend(target.userId))).body.approvalId as string;
      await admin.requestAndApprove(first.admin, first.security, {
        actionType: 'ROLE_CHANGE',
        payload: { userId: temporary.userId, role: 'ADMIN', operation: 'REVOKE' },
        reason: 'moved team',
      });
      const approved = await admin.decide(secondAdmin, id, 'approve');
      expect(approved.status).toBe(409);
      expect(approved.body.code).toBe('APPROVAL_REQUESTER_INELIGIBLE');
    });

    it('unknown fields, number amounts and unknown action types are refused before anything is stored', async () => {
      const before = await harness.snapshot();
      const bad = [
        { actionType: 'SUSPEND_USER', payload: { userId: randomUUID(), extra: 1 }, reason: 'x' },
        { actionType: 'WRITE_OFF', payload: { userId: randomUUID(), currency: 'NGN', amount: 100, valueTime: new Date().toISOString() }, reason: 'x' },
        { actionType: 'DELETE_EVERYTHING', payload: {}, reason: 'x' },
        { actionType: 'SUSPEND_USER', payload: { userId: randomUUID() } },
      ];
      for (const body of bad) {
        const response = await admin.request(first.admin, body);
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VALIDATION_FAILED');
      }
      const after = await harness.snapshot();
      expect(after.auditLogCount).toBe(before.auditLogCount);
    });

    it('break-glass outside its subset is refused 403 BREAK_GLASS_NOT_ALLOWED', async () => {
      const response = await admin.request(first.admin, {
        actionType: 'ROLE_CHANGE',
        payload: { userId: randomUUID(), role: 'ADMIN', operation: 'GRANT' },
        reason: 'urgent',
        breakGlass: true,
      });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('BREAK_GLASS_NOT_ALLOWED');
    });

    it('the detail carries the trail: requested → approved → executed → what it did, each with its actor', async () => {
      const target = await payments.signUp();
      const approval = await admin.requestAndApprove(first.admin, secondAdmin, suspend(target.userId));
      const detail = await admin.get(first.security, `approvals/${approval.approvalId as string}`);
      const trail = (detail.body as { trail: { action: string; actorId: string | null }[] }).trail;
      expect(trail.map((entry) => entry.action)).toEqual(
        expect.arrayContaining(['APPROVAL_REQUESTED', 'APPROVAL_APPROVED', 'APPROVAL_EXECUTED', 'USER_SUSPENDED']),
      );
      expect(trail.find((entry) => entry.action === 'APPROVAL_REQUESTED')?.actorId).toBe(first.admin.userId);
      expect(trail.find((entry) => entry.action === 'APPROVAL_APPROVED')?.actorId).toBe(secondAdmin.userId);
      expect(JSON.stringify(trail)).not.toMatch(/@example\.com/);
    });

    it('lists newest first, keyset-paginated, filters bound to the cursor', async () => {
      const page = await admin.get(first.admin, 'approvals?limit=2');
      expect(page.status).toBe(200);
      const body = page.body as { items: { requestedAt: string }[]; nextCursor: string };
      expect(body.items).toHaveLength(2);
      expect(body.items[0]!.requestedAt >= body.items[1]!.requestedAt).toBe(true);
      const next = await admin.get(first.admin, `approvals?limit=2&cursor=${body.nextCursor}`);
      expect(next.status).toBe(200);
      const wrongFilter = await admin.get(first.admin, `approvals?limit=2&status=PENDING&cursor=${body.nextCursor}`);
      expect(wrongFilter.status).toBe(400);
      expect(wrongFilter.body.code).toBe('INVALID_CURSOR');
    });
  });
});
