import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { APPROVAL_ACTION_TYPES, APPROVAL_STATUSES } from '../../src/database/migrations/1791244800001-CreateApprovals';
import { ACTION_POLICIES } from '../../src/modules/admin/actions/action-registry';
import { canTransitionApproval } from '../../src/modules/admin/approvals/approval-transitions';
import { APPROVAL_ACTION_TYPE_VALUES, APPROVAL_STATUS_VALUES, ApprovalStatus } from '../../src/modules/admin/approvals/approval.types';
import { Administrators, LedgerHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

const HASH = 'a'.repeat(64);

/**
 * Four-eyes BY CONSTRUCTION (design §9.2: "the approver is a different person is always true, not policy"): the
 * database refuses what the service would refuse, so bypassing the service changes nothing. Raw SQL as `fx_app`
 * and as a superuser; the transition table and the decider roles tested equal to their TypeScript mirrors.
 */
describe('Admin schema: approvals, roles, corrections (real Postgres 16)', () => {
  let harness: LedgerHarness;
  let app: Client;
  let superuser: Client;
  let first: Administrators;
  let secondAdmin: SignedUpUser;
  let plainUser: SignedUpUser;

  /** A PENDING approval inserted directly (as fx_app), requested by `requester`. */
  const pending = async (requester: string, overrides: { actionType?: string; breakGlass?: boolean } = {}): Promise<string> => {
    const [row] = (
      await app.query(
        `INSERT INTO approvals (action_type, payload, payload_hash, reason, is_break_glass, requested_by, expires_at)
         VALUES ($1, $2, $3, 'schema test', $4, $5, now() + interval '1 day') RETURNING id`,
        [overrides.actionType ?? 'SUSPEND_USER', JSON.stringify({ userId: randomUUID() }), HASH, overrides.breakGlass ?? false, requester],
      )
    ).rows as { id: string }[];
    return row!.id;
  };

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { payments: true });
    first = await harness.payments!.admin.bootstrap();
    secondAdmin = await harness.payments!.admin.grant('ADMIN', first.admin, first.security);
    plainUser = await harness.payments!.signUp();
    app = await harness.db.appClient();
    superuser = await harness.db.superuserClient();
  }, 180_000);

  afterAll(async () => {
    await app?.end();
    await superuser?.end();
    await harness?.close();
  });

  describe('mirrors', () => {
    it('the enums equal their TypeScript twins', async () => {
      expect([...APPROVAL_ACTION_TYPES]).toEqual(APPROVAL_ACTION_TYPE_VALUES);
      expect([...APPROVAL_STATUSES]).toEqual(APPROVAL_STATUS_VALUES);
      const types = (await app.query(`SELECT unnest(enum_range(NULL::approval_action_type))::text AS value`)).rows.map((row: { value: string }) => row.value);
      expect(types).toEqual(APPROVAL_ACTION_TYPE_VALUES);
    });

    it('approval_transition_allowed equals approval-transitions.ts, pair for pair, with and without break-glass', async () => {
      for (const breakGlass of [false, true]) {
        for (const from of APPROVAL_STATUS_VALUES) {
          for (const to of APPROVAL_STATUS_VALUES) {
            const { rows } = await app.query(`SELECT approval_transition_allowed($1, $2, $3) AS allowed`, [from, to, breakGlass]);
            expect({ from, to, breakGlass, allowed: rows[0].allowed }).toEqual({ from, to, breakGlass, allowed: canTransitionApproval(from, to, breakGlass) });
          }
        }
      }
    });

    it('approval_decider_role equals the policy table', async () => {
      for (const type of APPROVAL_ACTION_TYPE_VALUES) {
        const { rows } = await app.query(`SELECT approval_decider_role($1)::text AS role`, [type]);
        expect({ type, role: rows[0].role }).toEqual({ type, role: ACTION_POLICIES[type].deciderRole });
      }
    });
  });

  describe('four-eyes by construction', () => {
    it('four_eyes: the database refuses the requester as approver — for fx_app and for a superuser', async () => {
      const id = await pending(first.admin.userId);
      for (const client of [app, superuser]) {
        await expect(
          client.query(`UPDATE approvals SET status = 'APPROVED', approved_by = requested_by, approved_at = now() WHERE id = $1`, [id]),
        ).rejects.toThrow(/four_eyes/);
      }
      await expect(
        app.query(`UPDATE approvals SET status = 'REJECTED', rejected_by = requested_by, rejected_at = now(), rejection_reason = 'x' WHERE id = $1`, [id]),
      ).rejects.toThrow(/approvals_rejecter_differs/);
    });

    it('EXECUTED only through APPROVED: PENDING → EXECUTED without break-glass is refused', async () => {
      const id = await pending(first.admin.userId);
      await expect(
        app.query(`UPDATE approvals SET status = 'EXECUTED', executed_by = $2, executed_at = now(), result_reference = 'x' WHERE id = $1`, [id, secondAdmin.userId]),
      ).rejects.toThrow(/cannot move from PENDING to EXECUTED/);
    });

    it('one decision, one execution: every later move or rewrite is refused', async () => {
      const id = await pending(first.admin.userId);
      await app.query(`UPDATE approvals SET status = 'APPROVED', approved_by = $2, approved_at = now() WHERE id = $1`, [id, secondAdmin.userId]);
      await app.query(`UPDATE approvals SET status = 'EXECUTED', executed_by = $2, executed_at = now(), result_reference = 'r1' WHERE id = $1`, [
        id,
        secondAdmin.userId,
      ]);
      await expect(app.query(`UPDATE approvals SET result_reference = 'r2' WHERE id = $1`, [id])).rejects.toThrow(/change only with its status/);
      await expect(
        app.query(`UPDATE approvals SET status = 'EXECUTION_FAILED', execution_failure_code = 'X', result_reference = NULL WHERE id = $1`, [id]),
      ).rejects.toThrow(/cannot move from EXECUTED/);
      await expect(app.query(`UPDATE approvals SET status = 'REJECTED' WHERE id = $1`, [id])).rejects.toThrow(/cannot move from EXECUTED/);
      await expect(app.query(`UPDATE approvals SET status = 'PENDING' WHERE id = $1`, [id])).rejects.toThrow(/cannot move from EXECUTED/);
    });

    it('the executor is the approver (or the break-glass actor), nobody else', async () => {
      const id = await pending(first.admin.userId);
      await app.query(`UPDATE approvals SET status = 'APPROVED', approved_by = $2, approved_at = now() WHERE id = $1`, [id, secondAdmin.userId]);
      await expect(
        app.query(`UPDATE approvals SET status = 'EXECUTED', executed_by = $2, executed_at = now(), result_reference = 'x' WHERE id = $1`, [id, first.admin.userId]),
      ).rejects.toThrow(/approvals_executor_is_decider/);
    });

    it('eligibility: a plain user, a SECURITY officer on a money action, and an ADMIN on a role change cannot decide', async () => {
      const suspension = await pending(first.admin.userId);
      for (const decider of [plainUser.userId, first.security.userId]) {
        await expect(
          app.query(`UPDATE approvals SET status = 'APPROVED', approved_by = $2, approved_at = now() WHERE id = $1`, [suspension, decider]),
        ).rejects.toThrow(/may not decide/);
      }
      const roleChange = await pending(first.admin.userId, { actionType: 'ROLE_CHANGE' });
      await expect(
        app.query(`UPDATE approvals SET status = 'APPROVED', approved_by = $2, approved_at = now() WHERE id = $1`, [roleChange, secondAdmin.userId]),
      ).rejects.toThrow(/may not decide ROLE_CHANGE/);
      await expect(pending(plainUser.userId)).rejects.toThrow(/not an active ADMIN/);
    });

    it('a decision in flight holds the requester\'s and the decider\'s user rows: a role or status change must wait for it', async () => {
      const id = await pending(first.admin.userId);
      const deciding = await harness.db.appClient();
      const changing = await harness.db.appClient();
      try {
        await deciding.query('BEGIN');
        await deciding.query(`UPDATE approvals SET status = 'APPROVED', approved_by = $2, approved_at = now() WHERE id = $1`, [id, secondAdmin.userId]);
        await changing.query('BEGIN');
        for (const person of [first.admin.userId, secondAdmin.userId]) {
          await changing.query('SAVEPOINT attempt');
          // What apply_role_change / a suspension takes on the person's row:
          await expect(changing.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE NOWAIT`, [person])).rejects.toThrow(/could not obtain lock/);
          await changing.query('ROLLBACK TO SAVEPOINT attempt');
        }
      } finally {
        await changing.query('ROLLBACK').catch(() => undefined);
        await deciding.query('ROLLBACK').catch(() => undefined);
        await changing.end();
        await deciding.end();
      }
    });

    it('break-glass: its subset only, never with an approver, executed by its requester alone', async () => {
      await expect(pending(first.admin.userId, { actionType: 'CORRECTION', breakGlass: true })).rejects.toThrow(/approvals_break_glass_subset/);
      const id = await pending(first.admin.userId, { breakGlass: true });
      await expect(
        app.query(`UPDATE approvals SET status = 'APPROVED', approved_by = $2, approved_at = now() WHERE id = $1`, [id, secondAdmin.userId]),
      ).rejects.toThrow(/cannot move from PENDING to APPROVED/);
      await app.query(`UPDATE approvals SET status = 'EXECUTED', executed_by = requested_by, executed_at = now(), result_reference = 'x' WHERE id = $1`, [id]);
      // Reviewed once, by SECURITY, never by the actor (the eligibility trigger refuses before the CHECK would).
      await expect(
        app.query(`UPDATE approvals SET break_glass_reviewed_by = requested_by, break_glass_reviewed_at = now(), break_glass_review_note = 'x' WHERE id = $1`, [id]),
      ).rejects.toThrow(/not an active SECURITY officer/);
      await superuser.query(`ALTER TABLE approvals DISABLE TRIGGER approvals_check_eligibility`);
      try {
        await expect(
          superuser.query(`UPDATE approvals SET break_glass_reviewed_by = requested_by, break_glass_reviewed_at = now(), break_glass_review_note = 'x' WHERE id = $1`, [id]),
        ).rejects.toThrow(/approvals_reviewer_differs/);
      } finally {
        await superuser.query(`ALTER TABLE approvals ENABLE TRIGGER approvals_check_eligibility`);
      }
      await expect(
        app.query(`UPDATE approvals SET break_glass_reviewed_by = $2, break_glass_reviewed_at = now(), break_glass_review_note = 'x' WHERE id = $1`, [id, secondAdmin.userId]),
      ).rejects.toThrow(/not an active SECURITY officer/);
      await app.query(`UPDATE approvals SET break_glass_reviewed_by = $2, break_glass_reviewed_at = now(), break_glass_review_note = 'ok' WHERE id = $1`, [
        id,
        first.security.userId,
      ]);
      await expect(app.query(`UPDATE approvals SET break_glass_review_note = 'rewritten' WHERE id = $1`, [id])).rejects.toThrow(/already recorded/);
    });

    it('the request is immutable; approvals are never deleted or truncated, superuser included; fx_app writes decision columns only', async () => {
      const id = await pending(first.admin.userId);
      await expect(app.query(`UPDATE approvals SET payload = '{}' WHERE id = $1`, [id])).rejects.toThrow(/permission denied/);
      await expect(superuser.query(`UPDATE approvals SET payload = '{}' WHERE id = $1`, [id])).rejects.toThrow(/request is immutable/);
      await expect(superuser.query(`UPDATE approvals SET requested_by = $2 WHERE id = $1`, [id, secondAdmin.userId])).rejects.toThrow(/request is immutable/);
      await expect(app.query(`DELETE FROM approvals WHERE id = $1`, [id])).rejects.toThrow(/permission denied/);
      await expect(superuser.query(`DELETE FROM approvals WHERE id = $1`, [id])).rejects.toThrow(/never deleted/);
      await expect(superuser.query(`TRUNCATE approvals CASCADE`)).rejects.toThrow(/never truncated/);
    });

    it('a status shape that skips a column is refused (every column spelled out)', async () => {
      const id = await pending(first.admin.userId);
      await expect(app.query(`UPDATE approvals SET status = 'APPROVED', approved_by = $2 WHERE id = $1`, [id, secondAdmin.userId])).rejects.toThrow(
        /approvals_approval_recorded/,
      );
      await expect(app.query(`UPDATE approvals SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1`, [id])).rejects.toThrow(
        /approvals_cancellation_recorded/,
      );
    });
  });

  describe('the functions that alone may change a role, a pair, a period', () => {
    it('refuse anything that is not an APPROVED approval of their kind', async () => {
      const suspension = await pending(first.admin.userId);
      for (const call of ['apply_role_change', 'apply_currency_pair_change', 'close_reporting_period']) {
        await expect(app.query(`SELECT ${call}($1)`, [suspension])).rejects.toThrow(/needs an APPROVED/);
        await expect(app.query(`SELECT ${call}($1)`, [randomUUID()])).rejects.toThrow(/needs an APPROVED/);
      }
    });

    it('fx_app cannot write role_assignments, period_locks or currency_pairs directly', async () => {
      await expect(app.query(`INSERT INTO role_assignments (user_id, role, is_bootstrap) VALUES ($1, 'ADMIN', TRUE)`, [plainUser.userId])).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        app.query(`INSERT INTO period_locks (period_start, period_end, locked_by, reason) VALUES ('2020-01-01', '2020-02-01', 'operator:x', 'x')`),
      ).rejects.toThrow(/permission denied/);
      await expect(app.query(`UPDATE currency_pairs SET spread_basis_points = 0`)).rejects.toThrow(/permission denied/);
      await expect(superuser.query(`DELETE FROM role_assignments`)).rejects.toThrow(/never deleted/);
    });
  });

  describe('corrections of internal transactions, rate origins', () => {
    it('a CORRECTION of an internal transaction must name a subject; a subject is corrected once; a user transaction never takes one', async () => {
      const [internal] = (
        await superuser.query(
          `INSERT INTO transactions (reference, type, status, value_time, initiated_by) VALUES ($1, 'SETTLEMENT', 'POSTED', now(), 'job:test') RETURNING id`,
          [`schema-settlement:${randomUUID()}`],
        )
      ).rows as { id: string }[];
      const correction = (subject: string | null) =>
        superuser.query(
          `INSERT INTO transactions (reference, type, status, value_time, initiated_by, corrects_transaction_id, correction_subject)
           VALUES ($1, 'CORRECTION', 'POSTED', now(), 'operator:test', $2, $3)`,
          [`schema-correction:${randomUUID()}`, internal!.id, subject],
        );
      await expect(correction(null)).rejects.toThrow(/must name the subject/);
      await correction('line:one');
      await expect(correction('line:one')).rejects.toThrow(/transactions_corrects_transaction_subject_unique/);
      await correction('line:two');
      const [owned] = (
        await superuser.query(
          `INSERT INTO transactions (reference, type, status, value_time, initiated_by, user_id) VALUES ($1, 'FUNDING', 'POSTED', now(), 'job:test', $2) RETURNING id`,
          [`schema-funding:${randomUUID()}`, plainUser.userId],
        )
      ).rows as { id: string }[];
      await expect(
        superuser.query(
          `INSERT INTO transactions (reference, type, status, value_time, initiated_by, corrects_transaction_id, correction_subject, user_id)
           VALUES ($1, 'CORRECTION', 'POSTED', now(), 'operator:test', $2, 'line:x', $3)`,
          [`schema-correction:${randomUUID()}`, owned!.id, plainUser.userId],
        ),
      ).rejects.toThrow(/only a correction of an internal transaction names a subject/);
    });

    it('only an approval mints an OVERRIDE or MANUAL snapshot; `manual` is reserved; an override copies a REJECTED fetch', async () => {
      const insert = (provider: string, origin: string, status: string, extra: { approvalId?: string; overrides?: string } = {}) =>
        app.query(
          `INSERT INTO exchange_rate_snapshots
             (provider, base_currency_code, provider_updated_at, provider_next_update_at, fetched_at, status, rejection_reasons, origin, approval_id, overrides_snapshot_id)
           VALUES ($1, 'USD', now(), now() + interval '1 hour', now(), $3::exchange_rate_snapshot_status,
                   CASE WHEN $3::text = 'REJECTED' THEN ARRAY['RATE_JUMP:NGN'] ELSE '{}' END, $2::exchange_rate_snapshot_origin, $4, $5) RETURNING id`,
          [provider, origin, status, extra.approvalId ?? null, extra.overrides ?? null],
        );
      await expect(insert('manual', 'PROVIDER', 'ACCEPTED')).rejects.toThrow(/exchange_rate_snapshots_origin_shape/);
      await expect(insert('exchange-rate-api', 'MANUAL', 'ACCEPTED')).rejects.toThrow(/exchange_rate_snapshots_origin_shape/);
      await expect(insert('manual', 'MANUAL', 'ACCEPTED')).rejects.toThrow(/exchange_rate_snapshots_origin_shape/);
      const approvalId = await pending(first.admin.userId, { actionType: 'RATE_OVERRIDE' });
      const accepted = (await insert('exchange-rate-api', 'PROVIDER', 'ACCEPTED')).rows[0] as { id: string };
      await expect(insert('exchange-rate-api', 'OVERRIDE', 'ACCEPTED', { approvalId, overrides: accepted.id })).rejects.toThrow(/accepts a REJECTED fetch/);
    });
  });

  describe('status values', () => {
    it('PENDING is the only status an approval is created with', async () => {
      await expect(
        app.query(
          `INSERT INTO approvals (action_type, payload, payload_hash, reason, requested_by, expires_at, status)
           VALUES ('SUSPEND_USER', '{}', $1, 'x', $2, now() + interval '1 day', $3)`,
          [HASH, first.admin.userId, ApprovalStatus.APPROVED],
        ),
      ).rejects.toThrow();
    });
  });
});
