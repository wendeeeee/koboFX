import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { CONVERSION_STATES, canTransitionConversion } from '../../src/modules/trading/conversion-transitions';
import { LedgerHarness, PLACEHOLDER_PASSWORD_HASH, startLedgerHarness } from '../support/ledger-harness';

/**
 * Phase 7 schema (PHASE7_PLAN §A): the CONVERSION flow type and its transitions, and the
 * by-construction rules on `transactions` — a conversion carries its full provenance, cites
 * only an ACCEPTED snapshot, and a quote backs at most one conversion. Checked with the
 * superuser, so it is the schema refusing, not a grant.
 */
describe('Trading schema: conversion flows and provenance (integration)', () => {
  let harness: LedgerHarness;
  let app: Client;
  let superuser: Client;
  let userId: string;

  beforeAll(async () => {
    harness = await startLedgerHarness();
    app = await harness.db.appClient();
    superuser = await harness.db.superuserClient();
    userId = (
      await app.query<{ id: string }>(`INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`, [
        `trading-schema-${randomUUID()}@example.com`,
        PLACEHOLDER_PASSWORD_HASH,
      ])
    ).rows[0].id;
  });
  afterAll(async () => {
    await app?.end();
    await superuser?.end();
    await harness?.close();
  });

  const refused = async (client: Client, sql: string, params: unknown[], pattern: RegExp) => {
    await expect(client.query(sql, params)).rejects.toThrow(pattern);
  };

  async function snapshot(status: 'ACCEPTED' | 'REJECTED'): Promise<string> {
    await superuser.query('BEGIN');
    try {
      const {
        rows: [row],
      } = await superuser.query<{ id: string }>(
        `INSERT INTO exchange_rate_snapshots (provider, base_currency_code, provider_updated_at, provider_next_update_at, fetched_at, status, rejection_reasons)
         VALUES ('exchange-rate-api', 'USD', now() - interval '1 minute', now() + interval '4 minutes', now(), $1, $2) RETURNING id`,
        [status, status === 'REJECTED' ? ['RATE_NOT_POSITIVE:NGN'] : []],
      );
      for (const [currency, rate] of Object.entries({ USD: '1', NGN: '1530.50' })) {
        await superuser.query(`INSERT INTO exchange_rate_snapshot_rates (snapshot_id, currency_code, rate) VALUES ($1, $2, $3::numeric)`, [row.id, currency, rate]);
      }
      await superuser.query('COMMIT');
      return row.id;
    } catch (error) {
      await superuser.query('ROLLBACK');
      throw error;
    }
  }

  async function quote(snapshotId: string): Promise<string> {
    const { rows } = await superuser.query<{ id: string }>(
      `INSERT INTO quotes (user_id, source_currency_code, target_currency_code, amount_mode, source_amount_minor, target_amount_minor,
         target_mid_value_minor, revenue_minor, mid_rate, client_rate, spread_basis_points, source_reference_rate, target_reference_rate,
         rate_snapshot_id, rate_provider, rate_provider_updated_at, rate_fetched_at, issued_at, expires_at)
       VALUES ($1, 'NGN', 'USD', 'SOURCE', 100000000, 65011, 65338, 327, 0.00065338, 0.00065011, 50, 1530.50, 1, $2,
               'exchange-rate-api', now(), now(), now(), now() + interval '30 seconds') RETURNING id`,
      [userId, snapshotId],
    );
    return rows[0].id;
  }

  /** A CONVERSION row with full provenance; `overrides` replace columns (null to blank one). */
  async function insertConversion(overrides: Record<string, unknown>): Promise<void> {
    const values: Record<string, unknown> = {
      id: randomUUID(),
      reference: `conversion:${randomUUID()}`,
      user_id: userId,
      type: 'CONVERSION',
      status: 'POSTED',
      value_time: new Date(),
      initiated_by: `user:${userId}`,
      source_currency: 'NGN',
      source_amount_minor: '100000000',
      target_currency: 'USD',
      target_amount_minor: '65011',
      rate_display: '0.00065011',
      reference_rate: '0.000653381247958',
      rate_provider: 'exchange-rate-api',
      rate_fetched_at: new Date(),
      rate_provider_updated_at: new Date(),
      rate_snapshot_id: await snapshot('ACCEPTED'),
      spread_basis_points: 50,
      ...overrides,
    };
    const columns = Object.keys(values);
    await superuser.query(
      `INSERT INTO transactions (${columns.join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      Object.values(values),
    );
  }

  it('the SQL transition function agrees with conversion-transitions.ts on every pair of states', async () => {
    const disagreements: string[] = [];
    for (const from of CONVERSION_STATES) {
      for (const to of CONVERSION_STATES) {
        const { rows } = await app.query(`SELECT flow_transition_allowed('CONVERSION', $1, $2) AS allowed`, [from, to]);
        if ((rows[0] as { allowed: boolean }).allowed !== canTransitionConversion(from, to)) disagreements.push(`${from}→${to}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('a CONVERSION flow is INITIATED or POSTED only, and completes in POSTED', async () => {
    await refused(app, `INSERT INTO flow_instances (flow_type, state, user_id) VALUES ('CONVERSION', 'AUTHORIZED', $1)`, [userId], /flow_instances_state_valid/);
    const {
      rows: [{ id }],
    } = await app.query<{ id: string }>(`INSERT INTO flow_instances (flow_type, state, user_id) VALUES ('CONVERSION', 'INITIATED', $1) RETURNING id`, [userId]);
    await app.query(`UPDATE flow_instances SET state = 'POSTED', completed_at = now() WHERE id = $1`, [id]);
    await refused(app, `UPDATE flow_instances SET state = 'INITIATED' WHERE id = $1`, [id], /cannot move from POSTED/);
  });

  it('accepts a CONVERSION with full provenance, and refuses one missing any part of it', async () => {
    await expect(insertConversion({})).resolves.toBeUndefined();
    for (const column of [
      'source_currency', 'source_amount_minor', 'target_currency', 'target_amount_minor', 'rate_display', 'reference_rate',
      'rate_provider', 'rate_fetched_at', 'rate_provider_updated_at', 'rate_snapshot_id', 'spread_basis_points',
    ]) {
      await expect(insertConversion({ [column]: null })).rejects.toThrow(/transactions_conversion_provenance/);
    }
    await expect(insertConversion({ target_currency: 'NGN' })).rejects.toThrow(/transactions_conversion_provenance/);
    await expect(insertConversion({ source_amount_minor: '0' })).rejects.toThrow(/transactions_conversion_provenance/);
    await expect(insertConversion({ rate_display: '0' })).rejects.toThrow(/transactions_conversion_provenance/);
    await expect(insertConversion({ spread_basis_points: 10_000 })).rejects.toThrow(/transactions_conversion_provenance/);
  });

  it('a conversion may cite only an ACCEPTED snapshot', async () => {
    await expect(insertConversion({ rate_snapshot_id: await snapshot('REJECTED') })).rejects.toThrow(/not ACCEPTED/);
  });

  it('a quote backs at most one conversion', async () => {
    const quoteId = await quote(await snapshot('ACCEPTED'));
    await insertConversion({ quote_id: quoteId });
    await expect(insertConversion({ quote_id: quoteId })).rejects.toThrow(/transactions_quote_id_unique/);
  });

  it('non-conversion transactions are unaffected by the provenance rule', async () => {
    await expect(
      superuser.query(
        `INSERT INTO transactions (reference, user_id, type, status, value_time, initiated_by) VALUES ($1, $2, 'FUNDING', 'POSTED', now(), 'job:test')`,
        [`funding:${randomUUID()}`, userId],
      ),
    ).resolves.toBeDefined();
  });

  it('the rolling-limit window has its index', async () => {
    const { rows } = await app.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'transactions_conversion_window_index'`);
    expect(rows).toHaveLength(1);
  });
});
