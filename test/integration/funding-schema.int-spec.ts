import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { FUNDING_STATES, canTransition } from '../../src/modules/flows/funding/funding-transitions';
import { LedgerHarness, startLedgerHarness } from '../support/ledger-harness';

/**
 * Phase 5 schema guards: triggers and grants on every new table — as the runtime role,
 * as the owner, and as a superuser where the row is evidence (`provider_calls`,
 * `webhook_events`).
 */
describe('Phase 5 schema guards (flow_instances, funding_payments, idempotency_keys, webhook_events, provider_calls)', () => {
  let harness: LedgerHarness;
  let app: Client;
  let owner: Client;
  let superuser: Client;
  let userId: string;

  beforeAll(async () => {
    harness = await startLedgerHarness();
    app = await harness.db.appClient();
    owner = await harness.db.ownerClient();
    superuser = await harness.db.superuserClient();
    userId = (await harness.createWallet()).userId;
  });
  afterAll(async () => {
    await Promise.all([app?.end(), owner?.end(), superuser?.end()]);
    await harness?.close();
  });

  const refused = async (client: Client, sql: string, params: unknown[], pattern: RegExp) => {
    await expect(client.query(sql, params)).rejects.toThrow(pattern);
  };
  const newFlow = async (state = 'INITIATED') =>
    ((await app.query(`INSERT INTO flow_instances (flow_type, state, user_id) VALUES ('FUNDING', $1, $2) RETURNING id`, [state, userId]))
      .rows[0] as { id: string }).id;

  describe('flow_instances', () => {
    it('the SQL transition function agrees with funding-transitions.ts on every pair of states', async () => {
      const disagreements: string[] = [];
      for (const from of FUNDING_STATES) {
        for (const to of FUNDING_STATES) {
          const { rows } = await app.query(`SELECT flow_transition_allowed('FUNDING', $1, $2) AS allowed`, [from, to]);
          if ((rows[0] as { allowed: boolean }).allowed !== canTransition(from, to)) disagreements.push(`${from}→${to}`);
        }
      }
      expect(disagreements).toEqual([]);
    });

    it('state moves only along the table; identity is immutable; completion is set once, in a completion state', async () => {
      const id = await newFlow();
      await refused(app, `UPDATE flow_instances SET state = 'POSTED' WHERE id = $1`, [id], /cannot move from INITIATED to POSTED/);
      await refused(app, `UPDATE flow_instances SET completed_at = now() WHERE id = $1`, [id], /cannot complete in state INITIATED/);
      await app.query(`UPDATE flow_instances SET state = 'AUTHORIZED' WHERE id = $1`, [id]);
      await refused(app, `UPDATE flow_instances SET state = 'INITIATED' WHERE id = $1`, [id], /cannot move/);
      await app.query(`UPDATE flow_instances SET state = 'FAILED', completed_at = now() WHERE id = $1`, [id]);
      await refused(app, `UPDATE flow_instances SET completed_at = now() + interval '1 day' WHERE id = $1`, [id], /set once/);
      await refused(app, `UPDATE flow_instances SET state = 'AUTHORIZED' WHERE id = $1`, [id], /cannot move from FAILED/);
      // The owner is bound by the trigger too.
      await refused(owner, `UPDATE flow_instances SET user_id = $2 WHERE id = $1`, [id, (await harness.createWallet()).userId], /identity is immutable/);
      await refused(owner, `UPDATE flow_instances SET flow_type = 'FUNDING', created_at = now() - interval '1 day' WHERE id = $1`, [id], /identity is immutable/);
    });

    it('fx_app: column UPDATE only, no DELETE or TRUNCATE; the owner cannot delete either; states are CHECKed', async () => {
      const id = await newFlow();
      await refused(app, `UPDATE flow_instances SET user_id = user_id WHERE id = $1`, [id], /permission denied/);
      await refused(app, `DELETE FROM flow_instances WHERE id = $1`, [id], /permission denied/);
      await refused(app, `TRUNCATE flow_instances CASCADE`, [], /permission denied/);
      await refused(owner, `DELETE FROM flow_instances WHERE id = $1`, [id], /never deleted/);
      await refused(app, `INSERT INTO flow_instances (flow_type, state, user_id) VALUES ('FUNDING', 'DONE', $1)`, [userId], /flow_instances_state_valid/);
      await refused(app, `INSERT INTO flow_instances (flow_type, state, user_id, context) VALUES ('FUNDING', 'INITIATED', $1, '[]')`, [userId], /context_is_object/);
      await refused(app, `UPDATE flow_instances SET leased_until = now() WHERE id = $1`, [id], /lease_complete/);
    });

    it('reservations.flow_id now references flow_instances (Phase 3 decision 1)', async () => {
      const account = await harness.openUserAccount('NGN');
      await harness.fund(account, 10_000n);
      await refused(
        app,
        `INSERT INTO reservations (account_id, flow_id, amount_minor, expires_at) VALUES ($1, $2, 1, now() + interval '1 hour')`,
        [account.accountId, randomUUID()],
        /reservations_flow_id_foreign_key/,
      );
    });
  });

  describe('funding_payments', () => {
    const newPayment = async () => {
      const flowId = await newFlow();
      const account = await harness.openUserAccount('NGN');
      await app.query(
        `INSERT INTO funding_payments (flow_id, user_id, account_id, currency_code, amount_minor, provider, payment_method_token)
         VALUES ($1, $2, $3, 'NGN', 1000, 'simulated-psp', 'tok_x')`,
        [flowId, userId, account.accountId],
      );
      return flowId;
    };

    it('amount and identity are immutable; facts are set once; the token may only be cleared', async () => {
      const flowId = await newPayment();
      await refused(owner, `UPDATE funding_payments SET amount_minor = 2000 WHERE flow_id = $1`, [flowId], /immutable/);
      await refused(app, `UPDATE funding_payments SET payment_method_token = 'tok_other' WHERE flow_id = $1`, [flowId], /only be cleared/);
      await app.query(`UPDATE funding_payments SET payment_method_token = NULL, provider_payment_id = 'pay_1', captured_at = now() WHERE flow_id = $1`, [flowId]);
      await refused(app, `UPDATE funding_payments SET payment_method_token = 'tok_again' WHERE flow_id = $1`, [flowId], /only be cleared/);
      await refused(app, `UPDATE funding_payments SET provider_payment_id = 'pay_2' WHERE flow_id = $1`, [flowId], /already recorded/);
      await refused(app, `UPDATE funding_payments SET captured_at = now() + interval '1 hour' WHERE flow_id = $1`, [flowId], /already recorded/);
      await app.query(`UPDATE funding_payments SET provider_status = 'CAPTURED' WHERE flow_id = $1`, [flowId]);
    });

    it('grants: no amount update, no DELETE/TRUNCATE; positive amount; one row per PSP payment', async () => {
      const flowId = await newPayment();
      await refused(app, `UPDATE funding_payments SET amount_minor = 5 WHERE flow_id = $1`, [flowId], /permission denied/);
      await refused(app, `DELETE FROM funding_payments WHERE flow_id = $1`, [flowId], /permission denied/);
      await refused(app, `TRUNCATE funding_payments`, [], /permission denied/);
      await refused(owner, `DELETE FROM funding_payments WHERE flow_id = $1`, [flowId], /never deleted/);
      await app.query(`UPDATE funding_payments SET provider_payment_id = 'pay_dup' WHERE flow_id = $1`, [flowId]);
      const other = await newPayment();
      await refused(app, `UPDATE funding_payments SET provider_payment_id = 'pay_dup' WHERE flow_id = $1`, [other], /funding_payments_provider_payment_unique/);
      await refused(
        app,
        `INSERT INTO funding_payments (flow_id, user_id, account_id, currency_code, amount_minor, provider) SELECT $1, $2, account_id, 'NGN', 0, 'p' FROM funding_payments LIMIT 1`,
        [await newFlow(), userId],
        /funding_payments_amount_positive/,
      );
    });
  });

  describe('idempotency_keys', () => {
    const newKey = async () => {
      const key = `key-${randomUUID()}`;
      await app.query(`INSERT INTO idempotency_keys (user_id, endpoint, key, request_hash) VALUES ($1, 'POST /api/v1/wallet/fund', $2, $3)`, [
        userId,
        key,
        'a'.repeat(64),
      ]);
      return key;
    };

    it('no expiry column, key never deleted; hash and identity immutable; the outcome is final', async () => {
      const { rows } = await app.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'idempotency_keys'`);
      expect((rows as { column_name: string }[]).map((row) => row.column_name)).not.toContain('expires_at');
      const key = await newKey();
      await refused(app, `DELETE FROM idempotency_keys WHERE key = $1`, [key], /permission denied/);
      await refused(owner, `DELETE FROM idempotency_keys WHERE key = $1`, [key], /never expire/);
      await refused(owner, `UPDATE idempotency_keys SET request_hash = $2 WHERE key = $1`, [key, 'b'.repeat(64)], /immutable/);
      await refused(app, `UPDATE idempotency_keys SET request_hash = $2 WHERE key = $1`, [key, 'b'.repeat(64)], /permission denied/);
      await refused(app, `UPDATE idempotency_keys SET status = 'COMPLETED' WHERE key = $1`, [key], /response_when_final|completed_when_final/);
      await app.query(
        `UPDATE idempotency_keys SET status = 'COMPLETED', response_status_code = 202, response_body = '{}', completed_at = now() WHERE key = $1`,
        [key],
      );
      await refused(app, `UPDATE idempotency_keys SET response_body = '{"x":1}' WHERE key = $1`, [key], /final/);
      await refused(app, `UPDATE idempotency_keys SET status = 'FAILED_PERMANENT' WHERE key = $1`, [key], /final/);
    });

    it('CHECKs the key format and the hash format', async () => {
      await refused(app, `INSERT INTO idempotency_keys (user_id, endpoint, key, request_hash) VALUES ($1, 'POST /x', 'short', $2)`, [userId, 'a'.repeat(64)], /key_format/);
      await refused(app, `INSERT INTO idempotency_keys (user_id, endpoint, key, request_hash) VALUES ($1, 'POST /x', $2, 'nothex')`, [userId, `k-${randomUUID()}`], /request_hash_format/);
    });
  });

  describe('webhook_events (evidence)', () => {
    const newEvent = async (signatureValid: boolean, providerEventId: string | null = `evt_${randomUUID()}`) =>
      ((await app.query(
        `INSERT INTO webhook_events (provider, provider_event_id, raw_payload, headers, signature_valid, outcome, processed_at)
         VALUES ('simulated-psp', $1, $2, '{}', $3, $4::webhook_event_outcome, CASE WHEN $3 THEN NULL ELSE now() END) RETURNING id`,
        [providerEventId, Buffer.from('{"raw":true}'), signatureValid, signatureValid ? null : 'INVALID_SIGNATURE'],
      )).rows[0] as { id: string }).id;

    it('the raw payload and every evidence column are immutable — for a superuser too; never deleted or truncated', async () => {
      const id = await newEvent(true);
      for (const client of [app, owner, superuser]) {
        await refused(client, `UPDATE webhook_events SET raw_payload = 'forged' WHERE id = $1`, [id], /immutable|permission denied/);
        await refused(client, `UPDATE webhook_events SET signature_valid = false WHERE id = $1`, [id], /immutable|permission denied/);
        await refused(client, `DELETE FROM webhook_events WHERE id = $1`, [id], /never deleted|permission denied/);
      }
      await refused(superuser, `UPDATE webhook_events SET headers = '{"x":1}' WHERE id = $1`, [id], /immutable/);
      await refused(superuser, `TRUNCATE webhook_events CASCADE`, [], /never deleted/);
      await refused(app, `TRUNCATE webhook_events`, [], /permission denied/);
    });

    it('processing is set once; an invalid signature is never processable', async () => {
      const id = await newEvent(true);
      await app.query(`UPDATE webhook_events SET processed_at = now(), outcome = 'NO_CHANGE' WHERE id = $1`, [id]);
      await refused(app, `UPDATE webhook_events SET outcome = 'ADVANCED' WHERE id = $1`, [id], /already been processed/);
      await refused(app, `INSERT INTO webhook_events (provider, raw_payload, headers, signature_valid) VALUES ('p', 'x', '{}', false)`, [], /invalid_never_processed/);
    });

    it('dedupe is among VALID events only: a forged event cannot occupy a genuine event id', async () => {
      const eventId = `evt_${randomUUID()}`;
      await newEvent(false, eventId);
      await newEvent(false, eventId); // forgeries are all kept
      await newEvent(true, eventId); // the genuine one still gets in
      await refused(app, `INSERT INTO webhook_events (provider, provider_event_id, raw_payload, headers, signature_valid) VALUES ('simulated-psp', $1, 'x', '{}', true)`, [eventId], /webhook_events_provider_event_unique/);
    });
  });

  describe('provider_calls (evidence)', () => {
    it('append-only: UPDATE, DELETE and TRUNCATE raise — for a superuser too; fx_app may only SELECT/INSERT', async () => {
      const { rows } = await app.query(
        `INSERT INTO provider_calls (provider, operation, direction, correlation_id, request_body) VALUES ('p', 'get-payment', 'OUTBOUND', 'c', '{}') RETURNING id`,
      );
      const id = (rows[0] as { id: string }).id;
      await refused(app, `UPDATE provider_calls SET error = 'x' WHERE id = $1`, [id], /permission denied/);
      await refused(app, `DELETE FROM provider_calls WHERE id = $1`, [id], /permission denied/);
      await refused(app, `TRUNCATE provider_calls`, [], /permission denied/);
      for (const client of [owner, superuser]) {
        await refused(client, `UPDATE provider_calls SET response_status = 200 WHERE id = $1`, [id], /append-only/);
        await refused(client, `DELETE FROM provider_calls WHERE id = $1`, [id], /append-only/);
      }
      await refused(superuser, `TRUNCATE provider_calls`, [], /append-only/);
    });
  });
});
