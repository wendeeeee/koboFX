import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { IdempotencyMetrics } from '../../src/common/interceptors/idempotency/idempotency-metrics';
import { LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

/** The idempotency barrier (design §6.5) on `POST /wallet/fund`, and the wallet read endpoints. */
describe('idempotency barrier and wallet API (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let owner: Client;
  let superuser: Client;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { payments: true });
    payments = harness.payments!;
    owner = await harness.db.ownerClient();
    superuser = await harness.db.superuserClient();
  });
  afterAll(async () => {
    await owner?.end();
    await superuser?.end();
    await harness?.close();
  });

  const http = () => request(harness.auth!.app.getHttpServer());
  const body = (amount = '150000', currency = 'NGN') => ({ amount, currency, paymentMethodToken: 'tok_success_visa' });
  const flowCount = async (userId: string) =>
    ((await harness.dataSource.query(`SELECT count(*)::int AS n FROM flow_instances WHERE user_id = $1`, [userId])) as { n: number }[])[0].n;
  const keyRow = async (userId: string, key: string) =>
    ((await harness.dataSource.query(`SELECT status, response_status_code, flow_id FROM idempotency_keys WHERE user_id = $1 AND key = $2`, [
      userId,
      key,
    ])) as { status: string; response_status_code: number; flow_id: string | null }[])[0];

  it('same key + same body → the stored response, byte-identical, marked replayed; one flow; one PSP authorization', async () => {
    const metrics = harness.moduleRef.get(IdempotencyMetrics);
    const replaysBefore = metrics.idempotencyReplaysTotal;
    const authorizationsBefore = payments.psp.statistics().effectiveAuthorizations;
    const user = await payments.signUp();
    const key = randomUUID();
    const first = await payments.fund(user, body(), key);
    expect(first.status).toBe(202);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    await payments.drive();
    // Key order and whitespace do not make it a different request.
    const again = await payments.fund(user, { paymentMethodToken: 'tok_success_visa', currency: 'NGN', amount: '150000' }, key);
    expect(again.status).toBe(202);
    expect(again.text).toBe(first.text);
    expect(again.headers['content-type']).toBe(first.headers['content-type']);
    expect(again.headers['idempotent-replayed']).toBe('true');
    await payments.drive();
    expect(await flowCount(user.userId)).toBe(1);
    expect(payments.psp.statistics().effectiveAuthorizations - authorizationsBefore).toBe(1);
    expect(metrics.idempotencyReplaysTotal - replaysBefore).toBe(1);
    expect(await keyRow(user.userId, key)).toEqual({ status: 'COMPLETED', response_status_code: 202, flow_id: (first.body as { fundingId: string }).fundingId });
  });

  it('same key + different body → 409 IDEMPOTENCY_KEY_REUSE, nothing created', async () => {
    const user = await payments.signUp();
    const key = randomUUID();
    await payments.fund(user, body('150000'), key).expect(202);
    const reused = await payments.fund(user, body('150001'), key);
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSE');
    expect(await flowCount(user.userId)).toBe(1);
  });

  it('a permanent failure is stored and replayed verbatim; the client needs a new key', async () => {
    const user = await payments.signUp();
    for (const [failing, status, code] of [
      [body('50'), 422, 'AMOUNT_TOO_SMALL'],
      [body('1000', 'EUR'), 400, 'UNSUPPORTED_CURRENCY'],
      [{ ...body(), amount: 150000 }, 400, 'VALIDATION_FAILED'],
      [{ ...body(), paymentMethodToken: 'x' }, 400, 'VALIDATION_FAILED'],
    ] as const) {
      const key = randomUUID();
      const first = await payments.fund(user, failing, key);
      expect({ status: first.status, code: first.body.code }).toEqual({ status, code });
      await new Promise((resolve) => setTimeout(resolve, 5)); // a fresh error would carry a new timestamp
      const replay = await payments.fund(user, failing, key);
      expect(replay.status).toBe(status);
      expect(replay.text).toBe(first.text);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect((await keyRow(user.userId, key)).status).toBe('FAILED_PERMANENT');
    }
    expect(await flowCount(user.userId)).toBe(0);
  });

  it('a transient failure is NOT stored: the key stays claimable and the retry genuinely reprocesses', async () => {
    const user = await payments.signUp();
    const key = randomUUID();
    await owner.query('BEGIN');
    await owner.query('LOCK TABLE funding_payments IN EXCLUSIVE MODE');
    const busy = await payments.fund(user, body(), key);
    await owner.query('ROLLBACK');
    expect(busy.status).toBe(503);
    expect(busy.body.code).toBe('RESOURCE_BUSY');
    expect(busy.headers['retry-after']).toBe('1');
    expect(await keyRow(user.userId, key)).toBeUndefined();
    expect(await flowCount(user.userId)).toBe(0);

    const retry = await payments.fund(user, body(), key);
    expect(retry.status).toBe(202);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(await flowCount(user.userId)).toBe(1);
  });

  it('a duplicate while the original is in progress → 409 REQUEST_IN_PROGRESS with Retry-After; nothing stored', async () => {
    const user = await payments.signUp();
    const key = randomUUID();
    // Another live request holds the scope's lock.
    await owner.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`idempotency|${user.userId}|POST /api/v1/wallet/fund|${key}`]);
    const duplicate = await payments.fund(user, body(), key);
    await owner.query(`SELECT pg_advisory_unlock_all()`);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('REQUEST_IN_PROGRESS');
    expect(duplicate.headers['retry-after']).toBe('1');
    expect(await keyRow(user.userId, key)).toBeUndefined();
    await payments.fund(user, body(), key).expect(202);
  });

  it('a request whose process dies mid-way leaves no IN_PROGRESS key behind: the same key works afterwards', async () => {
    const user = await payments.signUp();
    const key = randomUUID();
    await owner.query('BEGIN');
    await owner.query('LOCK TABLE funding_payments IN EXCLUSIVE MODE');
    const pending = payments.fund(user, body(), key).then((response) => response);
    // Find the request's backend (blocked on our lock) and kill it, as a crash would.
    let killed = false;
    for (let attempt = 0; attempt < 50 && !killed; attempt += 1) {
      const { rows } = await superuser.query(
        `SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO funding_payments%'`,
      );
      if (rows.length === 1) {
        await superuser.query(`SELECT pg_terminate_backend($1)`, [(rows[0] as { pid: number }).pid]);
        killed = true;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(killed).toBe(true);
    const died = await pending;
    await owner.query('ROLLBACK');
    expect(died.status).toBeGreaterThanOrEqual(500);
    expect(await keyRow(user.userId, key)).toBeUndefined(); // no abandoned IN_PROGRESS
    const { rows } = await owner.query(`SELECT count(*)::int AS n FROM idempotency_keys WHERE status = 'IN_PROGRESS'`);
    expect((rows[0] as { n: number }).n).toBe(0);
    await payments.fund(user, body(), key).expect(202);
    expect(await flowCount(user.userId)).toBe(1);
  });

  it('keys are scoped per user: the same key from two users is two operations', async () => {
    const [alice, bob] = [await payments.signUp(), await payments.signUp()];
    const key = randomUUID();
    const a = await payments.fund(alice, body(), key).expect(202);
    const b = await payments.fund(bob, body(), key).expect(202);
    expect(a.body.fundingId).not.toBe(b.body.fundingId);
    expect(b.headers['idempotent-replayed']).toBeUndefined();
  });

  it('the header is required and validated', async () => {
    const user = await payments.signUp();
    const call = () => http().post(`/${API_PREFIX}/wallet/fund`).set('Authorization', `Bearer ${user.accessToken}`);
    const missing = await call().send(body());
    expect({ status: missing.status, code: missing.body.code }).toEqual({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
    for (const bad of ['short', 'x'.repeat(129), 'has spaces in it ok?', 'semi;colons;are;bad']) {
      const invalid = await call().set('Idempotency-Key', bad).send(body());
      expect({ bad, status: invalid.status, code: invalid.body.code }).toEqual({ bad, status: 400, code: 'IDEMPOTENCY_KEY_INVALID' });
    }
    expect(await flowCount(user.userId)).toBe(0);
  });

  describe('wallet reads are scoped by the caller', () => {
    const get = (user: SignedUpUser, path: string) => http().get(`/${API_PREFIX}${path}`).set('Authorization', `Bearer ${user.accessToken}`);

    it('GET /wallet: total, reserved and available per currency, as strings; only your own', async () => {
      const [alice, bob] = [await payments.signUp(), await payments.signUp()];
      await payments.fund(alice, body('150000')).expect(202);
      await payments.fund(alice, body('2500', 'USD')).expect(202);
      await payments.drive();
      const wallet = await get(alice, '/wallet').expect(200);
      expect(wallet.body).toEqual({
        balances: [
          { currency: 'NGN', minorUnit: 2, total: '150000', reserved: '0', available: '150000' },
          { currency: 'USD', minorUnit: 2, total: '2500', reserved: '0', available: '2500' },
        ],
      });
      expect((await get(bob, '/wallet').expect(200)).body).toEqual({
        balances: [{ currency: 'NGN', minorUnit: 2, total: '0', reserved: '0', available: '0' }],
      });
    });

    it('GET /wallet/fund/:id: another user\'s funding is simply not found; a malformed id is a 400', async () => {
      const [alice, bob] = [await payments.signUp(), await payments.signUp()];
      const { fundingId } = (await payments.fund(alice, body()).expect(202)).body as { fundingId: string };
      expect((await get(alice, `/wallet/fund/${fundingId}`).expect(200)).body).toMatchObject({ fundingId, status: 'PENDING' });
      const foreign = await get(bob, `/wallet/fund/${fundingId}`);
      expect({ status: foreign.status, code: foreign.body.code }).toEqual({ status: 404, code: 'FUNDING_NOT_FOUND' });
      expect((await get(alice, '/wallet/fund/not-a-uuid')).status).toBe(400);
    });
  });
});
