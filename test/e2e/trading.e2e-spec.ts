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
import { MockExchangeRateApi, RECORDED_RATES } from '../../src/mock-exchange-rate-api/mock-exchange-rate-api';
import { MockPsp } from '../../src/mock-psp/mock-psp';
import { FlowResumer } from '../../src/modules/flows/flow-resumer';
import { FxPoller } from '../../src/modules/fx/fx-poller';
import { LedgerChecksService } from '../../src/modules/ledger/ledger-checks.service';
import { EmailSender } from '../../src/modules/notifications/email/email-sender';
import { OutboxDispatcher } from '../../src/modules/outbox/outbox-dispatcher';
import { WebhookProcessor } from '../../src/modules/payments/webhooks/webhook-processor';
import { CapturingEmailSender } from '../support/auth-test-doubles';
import { paymentProviderTestSecrets } from '../support/authentication-secrets';
import { TestDatabase, startTestDatabase } from '../support/test-database';

const PASSWORD = 'an end-to-end trading password';
const TOKEN = 'tok_success_visa_e2e_trading';
const API_KEY = `e2etradekey${randomUUID().replace(/-/g, '').slice(0, 20)}`;

/**
 * register → verify → fund NGN (real PSP flow, signed webhooks) → GET /fx/rates → quote →
 * trade → GET /wallet (exact) → convert back → replays identical — through `configureApp()`,
 * a real listening server, Postgres, Redis, the worker's loops (flow resumer, webhook
 * processor, FX poller) running, the simulated PSP and the simulated ExchangeRate-API.
 */
describe('Trading (e2e: real pipeline, worker loops running)', () => {
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

  async function registerAndVerify(): Promise<string> {
    const email = `trading-e2e-${randomUUID().slice(0, 8)}@example.com`;
    await http().post(`/${API_PREFIX}/auth/register`).send({ email, password: PASSWORD }).expect(201);
    await app.get(OutboxDispatcher).dispatchDue(100);
    const code = emails.latestCodeFor(email);
    secrets.add(code);
    const verified = await http().post(`/${API_PREFIX}/auth/verify`).send({ email, password: PASSWORD, oneTimePassword: code }).expect(200);
    const access = verified.body.tokens.access.token as string;
    secrets.add(access).add(verified.body.tokens.refresh.token as string);
    return access;
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

  it('register → verify → fund → rates → quote → trade → wallet → convert back; replays identical; audit trail and books clean', async () => {
    const access = await registerAndVerify();
    const auth = { Authorization: `Bearer ${access}` };

    const fund = await http()
      .post(`/${API_PREFIX}/wallet/fund`)
      .set(auth)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '10000000', currency: 'NGN', paymentMethodToken: TOKEN })
      .expect(202);
    const funded = await eventually(
      async () => (await http().get(`/${API_PREFIX}/wallet/fund/${fund.body.fundingId}`).set(auth).expect(200)).body,
      (view: { status: string }) => view.status !== 'PENDING',
    );
    expect(funded.status).toBe('COMPLETED');

    const rates = await eventually(
      () => http().get(`/${API_PREFIX}/fx/rates`).set(auth),
      (response) => response.status === 200,
    );
    expect(rates.body).toMatchObject({ stale: false });

    // Quote ₦100,000 → USD, then execute it.
    const quote = await http()
      .post(`/${API_PREFIX}/fx/quotes`)
      .set(auth)
      .set('Idempotency-Key', randomUUID())
      .send({ from: 'NGN', to: 'USD', sourceAmount: '10000000' })
      .expect(201);
    expect(quote.body).toMatchObject({ sourceAmount: '10000000', targetAmount: '7409' });
    const tradeKey = randomUUID();
    const traded = await http().post(`/${API_PREFIX}/wallet/trade`).set(auth).set('Idempotency-Key', tradeKey).send({ quoteId: quote.body.quoteId }).expect(201);
    expect(traded.body).toMatchObject({
      type: 'CONVERSION',
      status: 'POSTED',
      quoteId: quote.body.quoteId,
      debited: { currency: 'NGN', minorUnit: 2, amount: '10000000' },
      credited: { currency: 'USD', minorUnit: 2, amount: '7409' },
      rateDisplay: '0.0007409',
    });

    const wallet = await http().get(`/${API_PREFIX}/wallet`).set(auth).expect(200);
    expect(wallet.body).toEqual({
      balances: [
        { currency: 'NGN', minorUnit: 2, total: '0', reserved: '0', available: '0' },
        { currency: 'USD', minorUnit: 2, total: '7409', reserved: '0', available: '7409' },
      ],
    });

    // Convert back: all $74.09 → NGN at the market rate (USD → NGN, 150 bps).
    const convertKey = randomUUID();
    const back = await http()
      .post(`/${API_PREFIX}/wallet/convert`)
      .set(auth)
      .set('Idempotency-Key', convertKey)
      .send({ from: 'USD', to: 'NGN', sourceAmount: '7409' })
      .expect(201);
    expect(back.body).toMatchObject({ quoteId: null, debited: { currency: 'USD', amount: '7409' }, credited: { currency: 'NGN' } });
    // The round trip costs two spreads: never more back than was sold.
    expect(BigInt(back.body.credited.amount)).toBeLessThan(10_000_000n);

    const replayTrade = await http().post(`/${API_PREFIX}/wallet/trade`).set(auth).set('Idempotency-Key', tradeKey).send({ quoteId: quote.body.quoteId }).expect(201);
    expect([replayTrade.text, replayTrade.headers['idempotent-replayed']]).toEqual([traded.text, 'true']);
    const replayConvert = await http()
      .post(`/${API_PREFIX}/wallet/convert`)
      .set(auth)
      .set('Idempotency-Key', convertKey)
      .send({ from: 'USD', to: 'NGN', sourceAmount: '7409' })
      .expect(201);
    expect([replayConvert.text, replayConvert.headers['idempotent-replayed']]).toEqual([back.text, 'true']);

    const final = await http().get(`/${API_PREFIX}/wallet`).set(auth).expect(200);
    expect(final.body.balances).toEqual([
      { currency: 'NGN', minorUnit: 2, total: back.body.credited.amount, reserved: '0', available: back.body.credited.amount },
      { currency: 'USD', minorUnit: 2, total: '0', reserved: '0', available: '0' },
    ]);

    // The audit trail, end to end (design §11 E2E).
    const dataSource = app.get(DataSource);
    const actions = (await dataSource.query(`SELECT action FROM audit_logs ORDER BY created_at, id`)) as { action: string }[];
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining(['USER_REGISTERED', 'USER_VERIFIED', 'FUNDING_INITIATED', 'CONVERSION_POSTED']),
    );
    expect(actions.filter((row) => row.action === 'CONVERSION_POSTED')).toHaveLength(2);
    // The ConversionPosted.v1 events are acknowledged by the worker, never dead-lettered.
    await app.get(OutboxDispatcher).dispatchDue(100);
    const events = (await dataSource.query(
      `SELECT published_at, failed_at FROM outbox_events WHERE event_type = 'ConversionPosted.v1'`,
    )) as { published_at: Date | null; failed_at: Date | null }[];
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.published_at !== null && event.failed_at === null)).toBe(true);
    expect((await app.get(LedgerChecksService).runAllChecks()).isClean).toBe(true);
  });

  it('deny by default: convert and trade need an authenticated user and an idempotency key', async () => {
    await http().post(`/${API_PREFIX}/wallet/convert`).set('Idempotency-Key', randomUUID()).send({ from: 'NGN', to: 'USD', sourceAmount: '100000' }).expect(401);
    await http().post(`/${API_PREFIX}/wallet/trade`).set('Idempotency-Key', randomUUID()).send({ quoteId: randomUUID() }).expect(401);
    const access = await registerAndVerify();
    const missingKey = await http().post(`/${API_PREFIX}/wallet/convert`).set('Authorization', `Bearer ${access}`).send({ from: 'NGN', to: 'USD', sourceAmount: '100000' });
    expect([missingKey.status, missingKey.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
  });

  it('log hygiene: no password, token, PSP or FX secret, one-time password or Authorization value in any log line', async () => {
    await http().post(`/${API_PREFIX}/wallet/convert`).set('Authorization', 'Bearer header.value.secret').send({}).expect(401);
    secrets.add('header.value.secret');
    const log = logLines.join('');
    expect(log).toContain('Conversion posted');
    expect(log).toContain('[REDACTED]');
    for (const secret of secrets) {
      if (!secret) continue;
      const leaked = /^\d+$/.test(secret) ? new RegExp(`(?<!\\d)${secret}(?!\\d)`).test(log) : log.includes(secret);
      expect({ secret: secret.slice(0, 12), leaked }).toEqual({ secret: secret.slice(0, 12), leaked: false });
    }
  });
});
