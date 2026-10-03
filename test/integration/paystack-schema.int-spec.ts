import { Client } from 'pg';
import {
  PAYSTACK_FUNDING_COMPLETION_STATES,
  PAYSTACK_FUNDING_STATES,
  PAYSTACK_FUNDING_TRANSITIONS,
} from '../../src/modules/flows/paystack-funding/paystack-funding-transitions';
import { LedgerHarness, startLedgerHarness } from '../support/ledger-harness';

/**
 * Paystack schema (PAYSTACK_PLAN.md D): the transition table equals its SQL mirror pair for pair; states and
 * completion are CHECKed and trigger-guarded; the checkout is set once; a `paystack` funding payment belongs to a
 * `PAYSTACK_FUNDING` flow and nothing else does; the per-provider account templates; per-provider runs.
 */
describe('Paystack schema guards', () => {
  let harness: LedgerHarness;
  let app: Client;
  let owner: Client;
  let userId: string;
  let accountId: string;

  beforeAll(async () => {
    harness = await startLedgerHarness();
    app = await harness.db.appClient();
    owner = await harness.db.ownerClient();
    const account = await harness.openUserAccount('NGN');
    userId = account.userId;
    accountId = account.accountId;
  });
  afterAll(async () => {
    await Promise.all([app?.end(), owner?.end()]);
    await harness?.close();
  });

  const refused = async (client: Client, sql: string, params: unknown[], pattern: RegExp) => {
    await expect(client.query(sql, params)).rejects.toThrow(pattern);
  };
  const newFlow = async (type = 'PAYSTACK_FUNDING', state = 'INITIATED') =>
    ((await app.query(`INSERT INTO flow_instances (flow_type, state, user_id) VALUES ($1, $2, $3) RETURNING id`, [type, state, userId]))
      .rows[0] as { id: string }).id;
  const newPayment = (flowId: string, provider: string) =>
    app.query(
      `INSERT INTO funding_payments (flow_id, user_id, account_id, currency_code, amount_minor, provider) VALUES ($1, $2, $3, 'NGN', 1000, $4)`,
      [flowId, userId, accountId, provider],
    );

  it('the SQL transition function agrees with paystack-funding-transitions.ts on every pair of states', async () => {
    const disagreements: string[] = [];
    for (const from of PAYSTACK_FUNDING_STATES) {
      for (const to of PAYSTACK_FUNDING_STATES) {
        const { rows } = await app.query(`SELECT flow_transition_allowed('PAYSTACK_FUNDING', $1, $2) AS allowed`, [from, to]);
        if ((rows[0] as { allowed: boolean }).allowed !== PAYSTACK_FUNDING_TRANSITIONS[from].includes(to)) disagreements.push(`${from}→${to}`);
      }
    }
    expect(disagreements).toEqual([]);
    // FUNDING and CONVERSION are untouched by the new definition.
    const { rows } = await app.query(
      `SELECT flow_transition_allowed('FUNDING', 'INITIATED', 'AUTHORIZED') AS funding, flow_transition_allowed('CONVERSION', 'INITIATED', 'POSTED') AS conversion,
              flow_transition_allowed('FUNDING', 'INITIATED', 'CHECKOUT_READY') AS crossed`,
    );
    expect(rows[0]).toEqual({ funding: true, conversion: true, crossed: false });
  });

  it('states are CHECKed per type; completion only in a completion state (HELD included), set once', async () => {
    await refused(app, `INSERT INTO flow_instances (flow_type, state, user_id) VALUES ('PAYSTACK_FUNDING', 'AUTHORIZED', $1)`, [userId], /flow_instances_state_valid/);
    await refused(app, `INSERT INTO flow_instances (flow_type, state, user_id) VALUES ('FUNDING', 'CHECKOUT_READY', $1)`, [userId], /flow_instances_state_valid/);
    const id = await newFlow();
    await refused(app, `UPDATE flow_instances SET completed_at = now() WHERE id = $1`, [id], /cannot complete in state INITIATED/);
    await app.query(`UPDATE flow_instances SET state = 'CHECKOUT_READY' WHERE id = $1`, [id]);
    await refused(app, `UPDATE flow_instances SET completed_at = now() WHERE id = $1`, [id], /cannot complete in state CHECKOUT_READY/);
    await app.query(`UPDATE flow_instances SET state = 'HELD', completed_at = now() WHERE id = $1`, [id]);
    await refused(app, `UPDATE flow_instances SET state = 'POSTED' WHERE id = $1`, [id], /cannot move from HELD to POSTED/);
    expect(PAYSTACK_FUNDING_COMPLETION_STATES).toContain('HELD');
  });

  it('a paystack funding payment belongs to a PAYSTACK_FUNDING flow, and only it', async () => {
    await refused(app, `SELECT 1`, [], /^$/).catch(() => undefined);
    await expect(newPayment(await newFlow('FUNDING'), 'paystack')).rejects.toThrow(/cannot belong to a FUNDING flow/);
    await expect(newPayment(await newFlow('PAYSTACK_FUNDING'), 'simulated-psp')).rejects.toThrow(/cannot belong to a PAYSTACK_FUNDING flow/);
    await newPayment(await newFlow('PAYSTACK_FUNDING'), 'paystack');
    await newPayment(await newFlow('FUNDING'), 'simulated-psp');
  });

  it('the checkout is set once, together, on Paystack payments only — the owner is bound too', async () => {
    const flowId = await newFlow();
    await newPayment(flowId, 'paystack');
    await refused(app, `UPDATE funding_payments SET checkout_authorization_url = 'https://x.example/c' WHERE flow_id = $1`, [flowId], /funding_payments_checkout_together/);
    await app.query(
      `UPDATE funding_payments SET checkout_authorization_url = 'https://checkout.example/a', checkout_access_code = 'a', checkout_expires_at = now() WHERE flow_id = $1`,
      [flowId],
    );
    await refused(app, `UPDATE funding_payments SET checkout_access_code = 'b' WHERE flow_id = $1`, [flowId], /checkout is set once/);
    await refused(owner, `UPDATE funding_payments SET checkout_expires_at = now() + interval '1 day' WHERE flow_id = $1`, [flowId], /checkout is set once/);
    const simulated = await newFlow('FUNDING');
    await newPayment(simulated, 'simulated-psp');
    await refused(
      app,
      `UPDATE funding_payments SET checkout_authorization_url = 'https://c.example/a', checkout_access_code = 'a', checkout_expires_at = now() WHERE flow_id = $1`,
      [simulated],
      /funding_payments_checkout_only_paystack/,
    );
    await refused(
      app,
      `UPDATE funding_payments SET checkout_authorization_url = 'javascript:alert(1)', checkout_access_code = 'a', checkout_expires_at = now() WHERE flow_id = $1`,
      [await newFlow().then(async (id) => (await newPayment(id, 'paystack'), id))],
      /funding_payments_checkout_url_https/,
    );
  });

  it('the Paystack account templates exist, and their codes never match the simulated PSP\'s', async () => {
    const { rows } = await app.query(
      `SELECT name, account_type, normal_side FROM system_account_templates WHERE name LIKE 'PAYSTACK_%' ORDER BY name`,
    );
    // The payout templates (withdrawals, W1) sit beside the funding ones and never match the receivable proof's codes.
    expect(rows).toEqual([
      { name: 'PAYSTACK_CLEARING', account_type: 'ASSET', normal_side: 'DEBIT' },
      { name: 'PAYSTACK_PAYOUT_BALANCE', account_type: 'ASSET', normal_side: 'DEBIT' },
      { name: 'PAYSTACK_PAYOUT_IN_TRANSIT', account_type: 'ASSET', normal_side: 'DEBIT' },
      { name: 'PAYSTACK_RECEIVABLE', account_type: 'ASSET', normal_side: 'DEBIT' },
    ]);
    const codes = await app.query(
      `SELECT count(*)::int AS count FROM accounts WHERE (code LIKE 'PSP_RECEIVABLE:%' OR code LIKE 'CLEARING:%') AND code LIKE '%PAYSTACK%'`,
    );
    expect((codes.rows[0] as { count: number }).count).toBe(0);
    const provisioned = await app.query(`SELECT count(*)::int AS count FROM accounts WHERE code = 'PAYSTACK_RECEIVABLE:NGN'`);
    expect((provisioned.rows[0] as { count: number }).count).toBeGreaterThan(0);
  });

  it('runs are per (kind, provider, period): the simulated PSP\'s and Paystack\'s coexist; provider is immutable; INTERNAL has none', async () => {
    const insert = (kind: string, provider: string | null) =>
      app.query(`INSERT INTO reconciliation_runs (kind, period_key, status, attempts, provider) VALUES ($1, '2999-01-01', 'RUNNING', 1, $2) RETURNING id`, [kind, provider]);
    const simulated = (await insert('EXTERNAL_DAILY', null)).rows[0] as { id: string };
    await insert('EXTERNAL_DAILY', 'paystack');
    await expect(insert('EXTERNAL_DAILY', 'paystack')).rejects.toThrow(/reconciliation_runs_period_unique/);
    await expect(insert('EXTERNAL_DAILY', null)).rejects.toThrow(/reconciliation_runs_period_unique/);
    await expect(insert('INTERNAL', 'paystack')).rejects.toThrow(/reconciliation_runs_internal_has_no_provider/);
    await refused(owner, `UPDATE reconciliation_runs SET provider = 'paystack' WHERE id = $1`, [simulated.id], /identity is immutable/);
  });
});
