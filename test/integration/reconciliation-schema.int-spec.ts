import { Client } from 'pg';
import { BREAK_TYPES } from '../../src/modules/reconciliation/break-types';
import { BREAK_STATUSES, canTransitionBreak } from '../../src/modules/reconciliation/break-transitions';
import { ReconciliationRunKind } from '../../src/modules/reconciliation/reconciliation-schedule';
import { LedgerHarness, PaymentsHarness, startLedgerHarness } from '../support/ledger-harness';

const DAY = 24 * 3600 * 1000;

/**
 * The reconciliation schema's guarantees, by construction (Phase 9 §B): evidence is append-only
 * even for a superuser; breaks move only along their table and resolve only with a cause; one
 * live break per subject; a deposit is settled at most once; `fx_app` cannot delete anything.
 */
describe('reconciliation: schema (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let superuser: Client;
  let app: Client;
  let batchRowId: string;
  let lineRowId: string;
  let runId: string;
  let flowId: string;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { payments: true });
    payments = harness.payments!;
    superuser = await harness.db.superuserClient();
    app = await harness.db.appClient();
    // One real settled deposit, so every table has a row.
    const user = await payments.signUp();
    const response = await payments.fund(user, { amount: '250000', currency: 'NGN', paymentMethodToken: 'tok_success_visa' });
    flowId = response.body.fundingId as string;
    await payments.drive();
    harness.auth!.clock.advance(2 * DAY);
    const [{ provider_payment_id: paymentId }] = (await harness.dataSource.query(`SELECT provider_payment_id FROM funding_payments WHERE flow_id = $1`, [flowId])) as {
      provider_payment_id: string;
    }[];
    payments.psp.settle({ currency: 'NGN', paymentIds: [paymentId] });
    runId = (await payments.reconciliation.run(ReconciliationRunKind.EXTERNAL_DAILY)).runId;
    [{ id: batchRowId }] = (await harness.dataSource.query(`SELECT id FROM settlement_batches LIMIT 1`)) as { id: string }[];
    [{ id: lineRowId }] = (await harness.dataSource.query(`SELECT id FROM settlement_batch_lines LIMIT 1`)) as { id: string }[];
  });
  afterAll(async () => {
    await superuser?.end();
    await app?.end();
    await harness?.close();
  });

  const newRun = async () =>
    ((await harness.dataSource.query(
      `INSERT INTO reconciliation_runs (kind, period_key, status) VALUES ('INTERNAL', to_char(now() + (random() * 100000)::int * interval '1 day', 'YYYY-MM-DD'), 'RUNNING') RETURNING id`,
    )) as { id: string }[])[0].id;
  const newBreak = async (subject: string, status = 'OPEN') =>
    ((await harness.dataSource.query(
      `INSERT INTO reconciliation_breaks (type, subject_key, status, detected_by_run_id, last_detected_run_id, escalated_at)
       VALUES ('UNSETTLED_PAST_WINDOW', $1, $2::reconciliation_break_status, $3, $3, CASE WHEN $2::reconciliation_break_status = 'ESCALATED' THEN now() END) RETURNING id`,
      [subject, status, runId],
    )) as { id: string }[])[0].id;

  describe('settlement evidence is append-only — for a superuser too', () => {
    it.each(['settlement_batches', 'settlement_batch_lines', 'settlement_report_versions'])('%s: UPDATE, DELETE and TRUNCATE raise', async (table) => {
      const [{ id }] = (await superuser.query(`SELECT id FROM ${table} LIMIT 1`)).rows as { id: string }[];
      await expect(superuser.query(`UPDATE ${table} SET id = id WHERE id = $1`, [id])).rejects.toThrow(/append-only settlement evidence/);
      await expect(superuser.query(`DELETE FROM ${table} WHERE id = $1`, [id])).rejects.toThrow(/append-only settlement evidence/);
      await expect(superuser.query(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/append-only settlement evidence/);
      await expect(app.query(`DELETE FROM ${table} WHERE id = $1`, [id])).rejects.toThrow(/permission denied/);
    });

    it('a deposit is settled at most once: a second ATTRIBUTED line for the same payment is refused', async () => {
      const [line] = (await superuser.query(`SELECT * FROM settlement_batch_lines WHERE id = $1`, [lineRowId])).rows as Record<string, unknown>[];
      await expect(
        app.query(
          `INSERT INTO settlement_batch_lines (batch_id, provider, provider_line_id, line_type, provider_payment_id, amount_minor, fee_minor, flow_id, attribution)
           VALUES ($1, $2, 'another-line', 'PAYMENT', $3, 1, 0, $4, 'ATTRIBUTED')`,
          [batchRowId, line.provider, line.provider_payment_id, line.flow_id],
        ),
      ).rejects.toThrow(/settlement_batch_lines_payment_settled_once/);
      // …but the same payment may appear again as CLEARING (a duplicate, whose money is real).
      await expect(
        app.query(
          `INSERT INTO settlement_batch_lines (batch_id, provider, provider_line_id, line_type, provider_payment_id, amount_minor, fee_minor, attribution)
           VALUES ($1, $2, 'duplicate-line', 'PAYMENT', $3, 1, 0, 'CLEARING')`,
          [batchRowId, line.provider, line.provider_payment_id],
        ),
      ).resolves.toBeDefined();
    });

    it('a POSTED batch must carry its transaction and add up; a REJECTED one must say why', async () => {
      await expect(
        app.query(
          `INSERT INTO settlement_batches (provider, provider_batch_id, currency_code, settled_at, gross_minor, fee_minor, chargeback_minor, net_minor, line_count, content_hash, status)
           VALUES ('x', 'stl_bad', 'NGN', now(), 100, 1, 0, 99, 1, repeat('a', 64), 'POSTED')`,
        ),
      ).rejects.toThrow(/settlement_batches_posted_complete/);
      await expect(
        app.query(
          `INSERT INTO settlement_batches (provider, provider_batch_id, currency_code, settled_at, gross_minor, fee_minor, chargeback_minor, net_minor, line_count, content_hash, status)
           VALUES ('x', 'stl_bad2', 'NGN', now(), 100, 1, 0, 99, 1, repeat('a', 64), 'REJECTED')`,
        ),
      ).rejects.toThrow(/settlement_batches_rejected_explained/);
    });
  });

  describe('funding_payments: settlement facts are set once, together, on a posted deposit', () => {
    it('refuses changing them, or setting one without the others', async () => {
      await expect(app.query(`UPDATE funding_payments SET settled_at = now() WHERE flow_id = $1`, [flowId])).rejects.toThrow(/already recorded that fact/);
      const [other] = (await harness.dataSource.query(
        `SELECT flow_id FROM funding_payments WHERE settled_at IS NULL AND funding_transaction_id IS NOT NULL LIMIT 1`,
      )) as { flow_id: string }[];
      if (other) {
        await expect(app.query(`UPDATE funding_payments SET settled_at = now() WHERE flow_id = $1`, [other.flow_id])).rejects.toThrow(
          /funding_payments_settlement_together/,
        );
      }
    });
  });

  describe('reconciliation_runs', () => {
    it('one run per kind and period; a finished run is immutable; RUNNING → MISSED is refused; nothing is deleted', async () => {
      const id = await newRun();
      const [{ period_key: period }] = (await harness.dataSource.query(`SELECT period_key FROM reconciliation_runs WHERE id = $1`, [id])) as { period_key: string }[];
      await expect(app.query(`INSERT INTO reconciliation_runs (kind, period_key, status) VALUES ('INTERNAL', $1, 'RUNNING')`, [period])).rejects.toThrow(
        /reconciliation_runs_period_unique/,
      );
      await expect(app.query(`UPDATE reconciliation_runs SET status = 'MISSED', finished_at = now() WHERE id = $1`, [id])).rejects.toThrow(/cannot move from RUNNING to MISSED/);
      await app.query(`UPDATE reconciliation_runs SET status = 'CLEAN', finished_at = now() WHERE id = $1`, [id]);
      await expect(app.query(`UPDATE reconciliation_runs SET summary = '{"edited": true}' WHERE id = $1`, [id])).rejects.toThrow(/finished .* immutable/);
      await expect(app.query(`UPDATE reconciliation_runs SET period_key = '2000-01-01' WHERE id = $1`, [id])).rejects.toThrow(/permission denied/);
      await expect(app.query(`DELETE FROM reconciliation_runs WHERE id = $1`, [id])).rejects.toThrow(/permission denied/);
      await expect(superuser.query(`DELETE FROM reconciliation_runs WHERE id = $1`, [id])).rejects.toThrow(/never deleted/);
      await expect(app.query(`INSERT INTO reconciliation_runs (kind, period_key, status) VALUES ('INTERNAL', 'yesterday', 'RUNNING')`)).rejects.toThrow(
        /reconciliation_runs_period_key_format/,
      );
    });
  });

  describe('reconciliation_breaks', () => {
    it('the SQL transition function is the pure table, pair for pair', async () => {
      for (const from of BREAK_STATUSES) {
        for (const to of BREAK_STATUSES) {
          const [{ allowed }] = (await harness.dataSource.query(`SELECT reconciliation_break_transition_allowed($1, $2) AS allowed`, [from, to])) as { allowed: boolean }[];
          expect({ from, to, allowed }).toEqual({ from, to, allowed: canTransitionBreak(from, to) });
        }
      }
    });

    it('the database enum lists exactly the code’s break types', async () => {
      const rows = (await harness.dataSource.query(
        `SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_type.oid = pg_enum.enumtypid WHERE typname = 'reconciliation_break_type' ORDER BY enumsortorder`,
      )) as { enumlabel: string }[];
      expect(rows.map((row) => row.enumlabel).sort()).toEqual([...BREAK_TYPES].sort());
    });

    it('one LIVE break per (type, subject); after resolution the subject may break again', async () => {
      const id = await newBreak('payment:schema:one');
      await expect(newBreak('payment:schema:one')).rejects.toThrow(/reconciliation_breaks_live_subject_unique/);
      await app.query(
        `UPDATE reconciliation_breaks SET status = 'RESOLVED', resolved_at = now(), resolution_kind = 'SETTLED_LATE', resolution_reference = 'x', resolved_by = 'job:test' WHERE id = $1`,
        [id],
      );
      await expect(newBreak('payment:schema:one')).resolves.toBeDefined();
    });

    it('RESOLVED needs the whole cause; nothing leaves RESOLVED; evidence is immutable; nothing is deleted', async () => {
      const id = await newBreak('payment:schema:two');
      await expect(app.query(`UPDATE reconciliation_breaks SET status = 'RESOLVED', resolved_at = now() WHERE id = $1`, [id])).rejects.toThrow(
        /reconciliation_breaks_resolution_complete/,
      );
      await expect(
        app.query(
          `UPDATE reconciliation_breaks SET status = 'RESOLVED', resolved_at = now(), resolution_kind = 'SETTLED_LATE', resolution_reference = 'x', resolved_by = 'someone' WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/reconciliation_breaks_resolved_by_format/);
      await app.query(`UPDATE reconciliation_breaks SET status = 'ESCALATED', escalated_at = now() WHERE id = $1`, [id]);
      await expect(app.query(`UPDATE reconciliation_breaks SET status = 'OPEN' WHERE id = $1`, [id])).rejects.toThrow(/cannot move from ESCALATED to OPEN/);
      await app.query(
        `UPDATE reconciliation_breaks SET status = 'RESOLVED', resolved_at = now(), resolution_kind = 'OPERATOR_RESOLVED', resolution_reference = 'x', resolved_by = 'job:test' WHERE id = $1`,
        [id],
      );
      await expect(app.query(`UPDATE reconciliation_breaks SET status = 'OPEN' WHERE id = $1`, [id])).rejects.toThrow(/cannot move from RESOLVED to OPEN/);
      await expect(app.query(`UPDATE reconciliation_breaks SET resolution_reference = 'y' WHERE id = $1`, [id])).rejects.toThrow(/already recorded that fact/);
      await expect(app.query(`UPDATE reconciliation_breaks SET details = '{"edited": true}' WHERE id = $1`, [id])).rejects.toThrow(/permission denied/);
      await expect(superuser.query(`UPDATE reconciliation_breaks SET details = '{"edited": true}' WHERE id = $1`, [id])).rejects.toThrow(/immutable/);
      await expect(superuser.query(`DELETE FROM reconciliation_breaks WHERE id = $1`, [id])).rejects.toThrow(/never deleted/);
    });

    it('findings are append-only evidence, for a superuser too', async () => {
      await harness.dataSource.query(`INSERT INTO reconciliation_findings (run_id, kind, subject) VALUES ($1, 'TEST', 'x')`, [runId]);
      await expect(superuser.query(`UPDATE reconciliation_findings SET subject = 'y' WHERE run_id = $1`, [runId])).rejects.toThrow(/append-only evidence/);
      await expect(superuser.query(`DELETE FROM reconciliation_findings WHERE run_id = $1`, [runId])).rejects.toThrow(/append-only evidence/);
      await expect(superuser.query(`TRUNCATE reconciliation_findings`)).rejects.toThrow(/append-only evidence/);
    });
  });
});
