import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { LedgerHarness, PLACEHOLDER_PASSWORD_HASH, startLedgerHarness } from '../support/ledger-harness';

/**
 * Phase 6 schema (PHASE6_PLAN §B): currency_pairs, exchange_rate_snapshots (+ rates),
 * quotes, and transactions.quote_id's foreign key. Guards in the Phase 2–5 style: evidence
 * is immutable and untruncatable for a superuser too; quotes change only by their single
 * consumption; fx_app's grants are narrow.
 */
describe('FX schema: tables, triggers and grants (integration)', () => {
  let harness: LedgerHarness;
  let app: Client;
  let owner: Client;
  let superuser: Client;

  beforeAll(async () => {
    harness = await startLedgerHarness();
    app = await harness.db.appClient();
    owner = await harness.db.ownerClient();
    superuser = await harness.db.superuserClient();
  });
  afterAll(async () => {
    await app?.end();
    await owner?.end();
    await superuser?.end();
    await harness?.close();
  });

  async function snapshot(client: Client, status: 'ACCEPTED' | 'REJECTED' = 'ACCEPTED', rates: Record<string, string> = { USD: '1', NGN: '1530.123456789012345' }): Promise<string> {
    await client.query('BEGIN');
    try {
      const {
        rows: [row],
      } = await client.query<{ id: string }>(
        `INSERT INTO exchange_rate_snapshots (provider, base_currency_code, provider_updated_at, provider_next_update_at, fetched_at, status, rejection_reasons)
         VALUES ('exchange-rate-api', 'USD', now() - interval '1 minute', now() + interval '4 minutes', now(), $1, $2) RETURNING id`,
        [status, status === 'REJECTED' ? ['RATE_NOT_POSITIVE:NGN'] : []],
      );
      for (const [currency, rate] of Object.entries(rates)) {
        await client.query(`INSERT INTO exchange_rate_snapshot_rates (snapshot_id, currency_code, rate) VALUES ($1, $2, $3::numeric)`, [row.id, currency, rate]);
      }
      await client.query('COMMIT');
      return row.id;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  async function user(): Promise<string> {
    const { rows } = await app.query<{ id: string }>(`INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`, [
      `fx-schema-${randomUUID()}@example.com`,
      PLACEHOLDER_PASSWORD_HASH,
    ]);
    return rows[0].id;
  }

  async function quote(overrides: Record<string, unknown> = {}): Promise<string> {
    const snapshotId = await snapshot(app);
    const values = {
      user_id: await user(),
      source_currency_code: 'NGN',
      target_currency_code: 'USD',
      amount_mode: 'SOURCE',
      source_amount_minor: '100000000',
      target_amount_minor: '65011',
      target_mid_value_minor: '65338',
      revenue_minor: '327',
      mid_rate: '0.0006533812479581836001306762495916367',
      client_rate: '0.0006501143417183926821300228683436785',
      spread_basis_points: 50,
      source_reference_rate: '1530.50',
      target_reference_rate: '1',
      rate_snapshot_id: snapshotId,
      rate_provider: 'exchange-rate-api',
      rate_provider_updated_at: new Date(Date.now() - 60_000),
      rate_fetched_at: new Date(),
      issued_at: new Date(),
      expires_at: new Date(Date.now() + 30_000),
      ...overrides,
    };
    const columns = Object.keys(values);
    const { rows } = await app.query<{ id: string }>(
      `INSERT INTO quotes (${columns.join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING id`,
      Object.values(values),
    );
    return rows[0].id;
  }

  describe('currency_pairs', () => {
    it('seeds all 12 directional pairs of NGN/USD/EUR/GBP: NGN pairs 150 bps, majors 50 bps, source minimums', async () => {
      const { rows } = await app.query<{ pair: string; spread_basis_points: number; minimum: string }>(
        `SELECT source_currency_code || '>' || target_currency_code AS pair, spread_basis_points,
                minimum_source_amount_minor::text AS minimum
           FROM currency_pairs ORDER BY 1`,
      );
      expect(rows).toHaveLength(12);
      for (const row of rows) {
        expect(row.spread_basis_points).toBe(row.pair.includes('NGN') ? 150 : 50);
        expect(row.minimum).toBe(row.pair.startsWith('NGN') ? '100000' : '100');
      }
    });

    it('fx_app may only read it (spread changes are four-eyes, §9.2)', async () => {
      await expect(app.query(`UPDATE currency_pairs SET spread_basis_points = 0`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`DELETE FROM currency_pairs`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`INSERT INTO currency_pairs VALUES ('JPY', 'USD', 1, 1)`)).rejects.toThrow(/permission denied/);
    });

    it('constraints: distinct currencies, spread in [0, 10000), positive minimum', async () => {
      await expect(owner.query(`INSERT INTO currency_pairs (source_currency_code, target_currency_code, spread_basis_points, minimum_source_amount_minor) VALUES ('USD', 'USD', 1, 1)`)).rejects.toThrow(/currency_pairs_distinct_currencies/);
      await expect(owner.query(`UPDATE currency_pairs SET spread_basis_points = 10000 WHERE source_currency_code = 'USD' AND target_currency_code = 'EUR'`)).rejects.toThrow(/currency_pairs_spread_range/);
      await expect(owner.query(`UPDATE currency_pairs SET minimum_source_amount_minor = 0 WHERE source_currency_code = 'USD' AND target_currency_code = 'EUR'`)).rejects.toThrow(/currency_pairs_minimum_positive/);
    });
  });

  describe('exchange_rate_snapshots — evidence', () => {
    it('stores rates exactly (unconstrained NUMERIC): provider text → stored → read back, digit for digit', async () => {
      const id = await snapshot(app, 'ACCEPTED', { USD: '1', NGN: '1530.123456789012345', EUR: '0.00000000000000000001' });
      const { rows } = await app.query<{ currency_code: string; rate: string }>(
        `SELECT currency_code, rate::text AS rate FROM exchange_rate_snapshot_rates WHERE snapshot_id = $1 ORDER BY currency_code`,
        [id],
      );
      expect(rows).toEqual([
        { currency_code: 'EUR', rate: '0.00000000000000000001' },
        { currency_code: 'NGN', rate: '1530.123456789012345' },
        { currency_code: 'USD', rate: '1' },
      ]);
    });

    it('an accepted snapshot may only hold positive rates; a rejected one keeps the evidence', async () => {
      await expect(snapshot(app, 'ACCEPTED', { USD: '1', NGN: '0' })).rejects.toThrow(/may only hold positive rates/);
      await expect(snapshot(app, 'REJECTED', { USD: '1', NGN: '-1' })).resolves.toEqual(expect.any(String));
    });

    it('rejection reasons iff REJECTED; accepted rows need both provider times and a USD base', async () => {
      await expect(app.query(`INSERT INTO exchange_rate_snapshots (provider, base_currency_code, fetched_at, status) VALUES ('p', 'USD', now(), 'REJECTED')`)).rejects.toThrow(/reasons_iff_rejected/);
      await expect(app.query(`INSERT INTO exchange_rate_snapshots (provider, base_currency_code, fetched_at, status) VALUES ('p', 'USD', now(), 'ACCEPTED')`)).rejects.toThrow(/accepted_has_times/);
      await expect(
        app.query(`INSERT INTO exchange_rate_snapshots (provider, base_currency_code, provider_updated_at, provider_next_update_at, fetched_at, status) VALUES ('p', 'EUR', now(), now(), now(), 'ACCEPTED')`),
      ).rejects.toThrow(/accepted_base_is_usd/);
    });

    it.each(['app', 'superuser'] as const)('UPDATE, DELETE and TRUNCATE raise — as %s', async (who) => {
      const client = who === 'app' ? app : superuser;
      const id = await snapshot(app);
      for (const statement of [
        `UPDATE exchange_rate_snapshots SET status = 'REJECTED', rejection_reasons = '{X}' WHERE id = '${id}'`,
        `DELETE FROM exchange_rate_snapshots WHERE id = '${id}'`,
        `UPDATE exchange_rate_snapshot_rates SET rate = 1 WHERE snapshot_id = '${id}'`,
        `DELETE FROM exchange_rate_snapshot_rates WHERE snapshot_id = '${id}'`,
        `TRUNCATE exchange_rate_snapshot_rates`,
        `TRUNCATE exchange_rate_snapshots CASCADE`,
      ]) {
        await expect(client.query(statement)).rejects.toThrow(who === 'app' ? /permission denied|append-only evidence/ : /append-only evidence/);
      }
    });
  });

  describe('quotes', () => {
    it('locks the §5.6 amounts; revenue must be exactly mid value − credit; the credit never above the mid', async () => {
      await expect(quote()).resolves.toEqual(expect.any(String));
      await expect(quote({ revenue_minor: '326' })).rejects.toThrow(/quotes_revenue_is_the_difference/);
      await expect(quote({ target_amount_minor: '65339', revenue_minor: '-1' })).rejects.toThrow(/quotes_revenue_is_the_difference/);
      await expect(quote({ client_rate: '0.001' })).rejects.toThrow(/quotes_client_rate_not_above_mid/);
      await expect(quote({ source_amount_minor: '0' })).rejects.toThrow(/quotes_amounts_positive/);
      await expect(quote({ expires_at: new Date(Date.now() - 1000) })).rejects.toThrow(/quotes_expires_after_issue/);
      await expect(quote({ source_currency_code: 'NGN', target_currency_code: 'NGN' })).rejects.toThrow(/foreign key/);
    });

    it('immutable except its single consumption, strictly before expiry; never deleted — fx_app may UPDATE consumed_at only', async () => {
      const id = await quote();
      await expect(app.query(`UPDATE quotes SET target_amount_minor = 65012, revenue_minor = 326 WHERE id = $1`, [id])).rejects.toThrow(/permission denied/);
      await expect(owner.query(`UPDATE quotes SET target_amount_minor = 65012, revenue_minor = 326 WHERE id = $1`, [id])).rejects.toThrow(/immutable except its single consumption/);
      await expect(app.query(`UPDATE quotes SET consumed_at = expires_at WHERE id = $1`, [id])).rejects.toThrow(/quotes_consumed_within_validity/);
      await app.query(`UPDATE quotes SET consumed_at = issued_at WHERE id = $1`, [id]);
      await expect(app.query(`UPDATE quotes SET consumed_at = issued_at + interval '1 second' WHERE id = $1`, [id])).rejects.toThrow(/already consumed/);
      await expect(app.query(`DELETE FROM quotes WHERE id = $1`, [id])).rejects.toThrow(/permission denied/);
      await expect(superuser.query(`DELETE FROM quotes WHERE id = $1`, [id])).rejects.toThrow(/never deleted/);
      await expect(superuser.query(`TRUNCATE quotes CASCADE`)).rejects.toThrow(/never deleted/);
    });

    it('transactions.quote_id now references quotes (Phase 2 forward reference closed)', async () => {
      const { rows } = await owner.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'transactions_quote_id_foreign_key'`,
      );
      expect(rows).toEqual([{ definition: 'FOREIGN KEY (quote_id) REFERENCES quotes(id)' }]);
      const { rows: types } = await owner.query<{ column_name: string; type: string }>(
        `SELECT column_name, format_type(atttypid, atttypmod) AS type FROM information_schema.columns
           JOIN pg_attribute ON attrelid = 'transactions'::regclass AND attname = column_name
          WHERE table_name = 'transactions' AND column_name IN ('rate_display', 'reference_rate') ORDER BY column_name`,
      );
      expect(types).toEqual([
        { column_name: 'rate_display', type: 'numeric' },
        { column_name: 'reference_rate', type: 'numeric' },
      ]);
    });
  });
});
