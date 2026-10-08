import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { API_PREFIX, PSP_WEBHOOK_PATH, configureApp } from '../../src/app.setup';
import { dec } from '../../src/common/money';
import { MockExchangeRateApi, RECORDED_RATES } from '../../src/mock-exchange-rate-api/mock-exchange-rate-api';
import { MockPsp } from '../../src/mock-psp/mock-psp';
import { FlowResumer } from '../../src/modules/flows/flow-resumer';
import { displayRate } from '../../src/modules/fx/pricing';
import { FxPoller } from '../../src/modules/fx/fx-poller';
import { LedgerChecksService } from '../../src/modules/ledger/ledger-checks.service';
import { EmailSender } from '../../src/modules/notifications/email/email-sender';
import { OutboxDispatcher } from '../../src/modules/outbox/outbox-dispatcher';
import { WebhookProcessor } from '../../src/modules/payments/webhooks/webhook-processor';
import { CapturingEmailSender } from '../support/auth-test-doubles';
import { paymentProviderTestSecrets } from '../support/authentication-secrets';
import { TestDatabase, startTestDatabase } from '../support/test-database';

const PASSWORD = 'an end-to-end history password';
const TOKEN = 'tok_success_visa_e2e_history';
const API_KEY = `e2ehistorykey${randomUUID().replace(/-/g, '').slice(0, 20)}`;

/**
 * Design §11's E2E row: register → verify → fund → quote → trade → convert → HISTORY, asserting
 * the audit trail end to end — every history item traced to its `transactions` row, its ledger
 * legs and its `audit_logs` rows, all consistent — through `configureApp()`, a real listening
 * server, Postgres, Redis, the worker's loops, the simulated PSP and ExchangeRate-API.
 */
describe('Transaction history (e2e: real pipeline, worker loops running)', () => {
  let db: TestDatabase;
  let redis: StartedRedisContainer;
  let api: MockExchangeRateApi;
  let psp: MockPsp;
  let app: NestExpressApplication;
  let loops: { stop(): Promise<void> }[] = [];
  const emails = new CapturingEmailSender();
  const logLines: string[] = [];
  const secrets = new Set<string>([PASSWORD, TOKEN, API_KEY]);
  const { secretKey, webhookSecret } = paymentProviderTestSecrets();

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine').start();
    api = new MockExchangeRateApi({ apiKey: API_KEY });
    const now = Date.now();
    api.publish({ rates: RECORDED_RATES, publishedAt: new Date(now - 30_000), nextUpdateAt: new Date(now + 300_000) });
    const apiUrl = await api.start();
    let webhookUrl = '';
    psp = new MockPsp({
      secretKey,
      webhookSecret,
      captureCompletion: { afterMilliseconds: 200 },
      autoDeliverWebhooks: true,
      deliverWebhook: async (body, headers) => (await fetch(webhookUrl, { method: 'POST', body, headers })).status,
    });
    const pspUrl = await psp.start();
    db = await startTestDatabase({
      REDIS_URL: redis.getConnectionUrl(),
      LOG_LEVEL: 'debug',
      PSP_BASE_URL: pspUrl,
      FLOW_POLL_INTERVAL_MILLISECONDS: '100',
      FX_RATE_BASE_URL: `${apiUrl}/v6/{apiKey}/latest`,
      FX_PROVIDER_PLAN: 'BUSINESS',
      EXCHANGE_RATE_API_KEY: API_KEY,
      FX_POLL_INTERVAL_MILLISECONDS: '100',
    });
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        logLines.push(chunk.toString('utf8'));
        done();
      },
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(db.env, { logStream })] })
      .overrideProvider(EmailSender)
      .useValue(emails)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    webhookUrl = `http://127.0.0.1:${port}${PSP_WEBHOOK_PATH}`;
    const resumer = app.get(FlowResumer);
    const processor = app.get(WebhookProcessor);
    const poller = app.get(FxPoller);
    resumer.start();
    processor.start();
    poller.start();
    loops = [resumer, processor, poller];
    secrets.add(secretKey).add(webhookSecret.toString('base64')).add(webhookSecret.toString('hex'));
  });

  afterAll(async () => {
    await Promise.all(loops.map((loop) => loop.stop()));
    await app?.close();
    await psp?.stop();
    await api?.stop();
    await db?.stop();
    await redis?.stop();
  });

  const http = () => request(app.getHttpServer());

  async function registerAndVerify(): Promise<{ access: string; userId: string }> {
    const email = `history-e2e-${randomUUID().slice(0, 8)}@example.com`;
    await http().post(`/${API_PREFIX}/auth/register`).send({ email, password: PASSWORD }).expect(201);
    await app.get(OutboxDispatcher).dispatchDue(100);
    const code = emails.latestCodeFor(email);
    secrets.add(code);
    const verified = await http().post(`/${API_PREFIX}/auth/verify`).send({ email, password: PASSWORD, oneTimePassword: code }).expect(200);
    const access = verified.body.tokens.access.token as string;
    secrets.add(access).add(verified.body.tokens.refresh.token as string);
    return { access, userId: verified.body.user.id as string };
  }

  async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMilliseconds = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMilliseconds;
    let value = await read();
    while (!done(value) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      value = await read();
    }
    return value;
  }

  it('register → verify → fund → quote → trade → convert → history: every item traced to its transaction, its legs and its audit rows', async () => {
    const { access, userId } = await registerAndVerify();
    const auth = { Authorization: `Bearer ${access}` };

    const fund = await http()
      .post(`/${API_PREFIX}/wallet/fund`)
      .set(auth)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '10000000', currency: 'NGN', paymentMethodToken: TOKEN })
      .expect(202);
    // Before it posts, the funding is already in the history, PENDING, under its final reference.
    const early = await http().get(`/${API_PREFIX}/transactions/funding:${fund.body.fundingId}`).set(auth).expect(200);
    expect(['PENDING', 'COMPLETED']).toContain(early.body.status);
    const funded = await eventually(
      async () => (await http().get(`/${API_PREFIX}/wallet/fund/${fund.body.fundingId}`).set(auth).expect(200)).body,
      (view: { status: string }) => view.status !== 'PENDING',
    );
    expect(funded.status).toBe('COMPLETED');
    await eventually(() => http().get(`/${API_PREFIX}/fx/rates`).set(auth), (response) => response.status === 200);

    const quote = await http()
      .post(`/${API_PREFIX}/fx/quotes`)
      .set(auth)
      .set('Idempotency-Key', randomUUID())
      .send({ from: 'NGN', to: 'USD', sourceAmount: '5000000' })
      .expect(201);
    const traded = await http().post(`/${API_PREFIX}/wallet/trade`).set(auth).set('Idempotency-Key', randomUUID()).send({ quoteId: quote.body.quoteId }).expect(201);
    const converted = await http()
      .post(`/${API_PREFIX}/wallet/convert`)
      .set(auth)
      .set('Idempotency-Key', randomUUID())
      .send({ from: 'NGN', to: 'EUR', sourceAmount: '2000000' })
      .expect(201);

    // History: exactly three items, newest value time first.
    const history = await http().get(`/${API_PREFIX}/transactions`).set(auth).expect(200);
    expect(history.body.nextCursor).toBeNull();
    const items = history.body.items as {
      reference: string;
      type: string;
      status: string;
      reasonCode: string;
      legs: { currency: string; minorUnit: number; direction: string; amount: string }[];
      rate: { rateDisplay: string; quoteId: string | null } | null;
      valueTime: string;
      bookingTime: string;
    }[];
    expect(items.map((item) => item.reference).sort()).toEqual([`funding:${fund.body.fundingId}`, traded.body.reference, converted.body.reference].sort());
    const valueTimes = items.map((item) => item.valueTime);
    expect([...valueTimes].sort().reverse()).toEqual(valueTimes);

    const dataSource = app.get(DataSource);
    for (const item of items) {
      // The transactions row behind it.
      const [row] = (await dataSource.query(
        `SELECT id::text AS id, type::text AS type, status::text AS status, reason_code, user_id::text AS user_id, rate_display::text AS rate_display,
                quote_id::text AS quote_id, value_time, booking_time
           FROM transactions WHERE reference = $1`,
        [item.reference],
      )) as Record<string, any>[];
      expect(row.user_id).toBe(userId);
      expect(item).toMatchObject({
        type: row.type,
        status: row.status === 'POSTED' ? 'COMPLETED' : row.status,
        reasonCode: row.reason_code,
        valueTime: row.value_time.toISOString(),
        bookingTime: row.booking_time.toISOString(),
        rate: row.rate_display === null ? null : { rateDisplay: displayRate(dec(row.rate_display)), quoteId: row.quote_id },
      });
      // Its ledger legs: the user's, exactly.
      const legs = (await dataSource.query(
        `SELECT ledger_entries.currency_code AS currency, currencies.minor_unit AS "minorUnit", ledger_entries.direction::text AS direction,
                ledger_entries.amount_minor::text AS amount
           FROM ledger_entries JOIN accounts ON accounts.id = ledger_entries.account_id JOIN wallets ON wallets.id = accounts.wallet_id
           JOIN currencies ON currencies.code = ledger_entries.currency_code
          WHERE ledger_entries.transaction_id = $1 AND wallets.user_id = $2
          ORDER BY ledger_entries.direction, ledger_entries.id`,
        [row.id, userId],
      )) as Record<string, unknown>[];
      expect(item.legs).toEqual(legs);
      // Its audit rows: the flow named by the reference, performed by this user, pointing at this transaction.
      const flowId = item.reference.split(':')[1];
      const audit = (await dataSource.query(
        `SELECT action, actor_type::text AS actor_type, actor_id::text AS actor_id, after FROM audit_logs
          WHERE subject_type = 'FLOW' AND subject_id = $1 ORDER BY occurred_at, id`,
        [flowId],
      )) as { action: string; actor_type: string; actor_id: string | null; after: Record<string, unknown> | null }[];
      if (item.type === 'FUNDING') {
        expect(audit[0]).toMatchObject({ action: 'FUNDING_INITIATED', actor_type: 'USER', actor_id: userId });
        expect(audit.filter((entry) => entry.after?.transactionId === row.id)).toEqual([
          expect.objectContaining({ action: 'FUNDING_STATE_CHANGED', after: expect.objectContaining({ flowState: 'POSTED' }) }),
        ]);
      } else {
        expect(audit).toEqual([expect.objectContaining({ action: 'CONVERSION_POSTED', actor_type: 'USER', actor_id: userId, after: expect.objectContaining({ transactionId: row.id }) })]);
      }
      // The detail says the same, and more.
      const detail = await http().get(`/${API_PREFIX}/transactions/${item.reference}`).set(auth).expect(200);
      expect(detail.body).toMatchObject({ ...item, legs: item.legs.map((leg) => expect.objectContaining(leg)) });
    }

    // What the trade and the convert responses said is what history says.
    const byReference = new Map(items.map((item) => [item.reference, item]));
    expect(byReference.get(traded.body.reference)!.rate).toEqual({ rateDisplay: traded.body.rateDisplay, quoteId: quote.body.quoteId });
    expect(byReference.get(converted.body.reference)!.rate).toEqual({ rateDisplay: converted.body.rateDisplay, quoteId: null });

    // The user's legs per currency sum to the wallet.
    const wallet = (await http().get(`/${API_PREFIX}/wallet`).set(auth).expect(200)).body.balances as { currency: string; total: string }[];
    for (const balance of wallet) {
      const sum = items
        .flatMap((item) => item.legs)
        .filter((leg) => leg.currency === balance.currency)
        .reduce((total, leg) => total + (leg.direction === 'CREDIT' ? BigInt(leg.amount) : -BigInt(leg.amount)), 0n);
      expect({ currency: balance.currency, sum: sum.toString() }).toEqual({ currency: balance.currency, sum: balance.total });
    }
    // Filtered and paged views agree with the whole.
    const usd = await http().get(`/${API_PREFIX}/transactions`).query({ currency: 'USD' }).set(auth).expect(200);
    expect(usd.body.items.map((item: { reference: string }) => item.reference)).toEqual([traded.body.reference]);
    const pageOne = await http().get(`/${API_PREFIX}/transactions`).query({ limit: '2' }).set(auth).expect(200);
    const pageTwo = await http().get(`/${API_PREFIX}/transactions`).query({ limit: '2', cursor: pageOne.body.nextCursor }).set(auth).expect(200);
    expect([...pageOne.body.items, ...pageTwo.body.items]).toEqual(items);
    expect(pageTwo.body.nextCursor).toBeNull();

    expect((await app.get(LedgerChecksService).runAllChecks()).isClean).toBe(true);
  });

  it('deny by default on both routes; no idempotency key needed to read', async () => {
    await http().get(`/${API_PREFIX}/transactions`).expect(401);
    await http().get(`/${API_PREFIX}/transactions/funding:${randomUUID()}`).expect(401);
    await http().get(`/${API_PREFIX}/transactions`).set('Authorization', 'Bearer not.a.token').expect(401);
    const { access } = await registerAndVerify();
    const empty = await http().get(`/${API_PREFIX}/transactions`).set('Authorization', `Bearer ${access}`).expect(200);
    expect(empty.body).toEqual({ items: [], nextCursor: null });
    const missing = await http().get(`/${API_PREFIX}/transactions/funding:${randomUUID()}`).set('Authorization', `Bearer ${access}`);
    expect([missing.status, missing.body.code]).toEqual([404, 'TRANSACTION_NOT_FOUND']);
  });

  it('log hygiene: no secret in any log line, and history reads log no amounts', async () => {
    const log = logLines.join('');
    for (const secret of secrets) {
      if (!secret) continue;
      const leaked = /^\d+$/.test(secret) ? new RegExp(`(?<!\\d)${secret}(?!\\d)`).test(log) : log.includes(secret);
      expect({ secret: secret.slice(0, 12), leaked }).toEqual({ secret: secret.slice(0, 12), leaked: false });
    }
    // Reads don't log rows (design §10: money movements log amounts; reads don't).
    const historyLines = logLines.filter((line) => line.includes('/transactions'));
    expect(historyLines.length).toBeGreaterThan(0);
    for (const line of historyLines) {
      expect(line).not.toMatch(/"(amount|legs|rateDisplay|balanceAfter)"/);
    }
  });
});
