import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { API_PREFIX, configureApp } from '../../src/app.setup';
import { MockExchangeRateApi, RECORDED_RATES } from '../../src/mock-exchange-rate-api/mock-exchange-rate-api';
import { FxPoller } from '../../src/modules/fx/fx-poller';
import { EmailSender } from '../../src/modules/notifications/email/email-sender';
import { OutboxDispatcher } from '../../src/modules/outbox/outbox-dispatcher';
import { CapturingEmailSender } from '../support/auth-test-doubles';
import { TestDatabase, startTestDatabase } from '../support/test-database';

const PASSWORD = 'an end-to-end fx password';
const API_KEY = `e2efxkey${randomUUID().replace(/-/g, '').slice(0, 20)}`;

/**
 * register → verify → GET /fx/rates → POST /fx/quotes → GET /fx/quotes/:id → replay —
 * through `configureApp()`, a real listening server, Postgres, Redis, the worker's FX poller
 * loop running, and the simulated ExchangeRate-API (keyed: the key travels in the URL path).
 */
describe('FX (e2e: real pipeline, poller loop running)', () => {
  let db: TestDatabase;
  let redis: StartedRedisContainer;
  let api: MockExchangeRateApi;
  let app: NestExpressApplication;
  let poller: FxPoller;
  const emails = new CapturingEmailSender();
  const logLines: string[] = [];
  const secrets = new Set<string>([PASSWORD, API_KEY]);

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine').start();
    api = new MockExchangeRateApi({ apiKey: API_KEY });
    const now = Date.now();
    api.publish({ rates: RECORDED_RATES, publishedAt: new Date(now - 30_000), nextUpdateAt: new Date(now + 300_000) });
    const apiUrl = await api.start();
    db = await startTestDatabase({
      REDIS_URL: redis.getConnectionUrl(),
      LOG_LEVEL: 'debug',
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
    // The worker's FX poller (worker.ts), running against the same database and Redis.
    poller = app.get(FxPoller);
    poller.start();
  });

  afterAll(async () => {
    await poller?.stop();
    await app?.close();
    await api?.stop();
    await db?.stop();
    await redis?.stop();
  });

  const http = () => request(app.getHttpServer());

  async function registerAndVerify(): Promise<string> {
    const email = `fx-e2e-${randomUUID().slice(0, 8)}@example.com`;
    await http().post(`/${API_PREFIX}/auth/register`).send({ email, password: PASSWORD }).expect(201);
    await app.get(OutboxDispatcher).dispatchDue(100);
    const code = emails.latestCodeFor(email);
    secrets.add(code);
    const verified = await http().post(`/${API_PREFIX}/auth/verify`).send({ email, password: PASSWORD, oneTimePassword: code }).expect(200);
    const access = verified.body.tokens.access.token as string;
    secrets.add(access).add(verified.body.tokens.refresh.token as string);
    return access;
  }

  async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMilliseconds = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMilliseconds;
    let value = await read();
    while (!done(value) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      value = await read();
    }
    return value;
  }

  it('register → verify → rates → quote → get quote → the same key replayed returns the original quote', async () => {
    const access = await registerAndVerify();
    // The poller fetched on its first tick; the provider was called once, not per request.
    const rates = await eventually(
      () => http().get(`/${API_PREFIX}/fx/rates`).set('Authorization', `Bearer ${access}`),
      (response) => response.status === 200,
    );
    expect(rates.status).toBe(200);
    expect(rates.body).toMatchObject({ provider: 'exchange-rate-api', stale: false, attribution: { text: 'Rates By Exchange Rate API' } });
    expect(api.requests).toBe(1);

    const key = randomUUID();
    const body = { from: 'NGN', to: 'USD', sourceAmount: '100000' };
    const quote = await http().post(`/${API_PREFIX}/fx/quotes`).set('Authorization', `Bearer ${access}`).set('Idempotency-Key', key).send(body).expect(201);
    expect(quote.body).toMatchObject({ from: 'NGN', to: 'USD', sourceAmount: '100000', targetAmount: '74', status: 'OPEN' });

    const fetched = await http().get(`/${API_PREFIX}/fx/quotes/${quote.body.quoteId}`).set('Authorization', `Bearer ${access}`).expect(200);
    expect(fetched.body).toEqual(quote.body);

    const replay = await http().post(`/${API_PREFIX}/fx/quotes`).set('Authorization', `Bearer ${access}`).set('Idempotency-Key', key).send(body).expect(201);
    expect(replay.text).toBe(quote.text);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const [{ quotes }] = (await app.get(DataSource).query(`SELECT count(*)::int AS quotes FROM quotes`)) as { quotes: number }[];
    expect(quotes).toBe(1);
    expect(api.requests).toBe(1);
  });

  it('GET /fx/rates needs a session but not a verified one; quotes need a verified user', async () => {
    const email = `fx-unverified-${randomUUID().slice(0, 8)}@example.com`;
    await http().post(`/${API_PREFIX}/auth/register`).send({ email, password: PASSWORD }).expect(201);
    await http().get(`/${API_PREFIX}/fx/rates`).expect(401);
    await http().post(`/${API_PREFIX}/fx/quotes`).set('Idempotency-Key', randomUUID()).send({ from: 'NGN', to: 'USD', sourceAmount: '100000' }).expect(401);
  });

  it('/health/ready reports rate freshness without failing on it', async () => {
    const ready = await http().get(`/${API_PREFIX}/health/ready`).expect(200);
    expect(ready.body.fx).toMatchObject({ tier: 'EXECUTABLE', provider: 'exchange-rate-api' });
  });

  it('log hygiene: no ExchangeRate-API key (it travels in the URL path), token or Authorization value in any log line', async () => {
    await http().get(`/${API_PREFIX}/fx/rates`).set('Authorization', 'Bearer header.value.secret').expect(401);
    secrets.add('header.value.secret');
    const log = logLines.join('');
    expect(log.length).toBeGreaterThan(1000);
    expect(log).toContain('[REDACTED]');
    for (const secret of secrets) {
      if (!secret) continue;
      const leaked = /^\d+$/.test(secret) ? new RegExp(`(?<!\\d)${secret}(?!\\d)`).test(log) : log.includes(secret);
      expect({ secret: secret.slice(0, 12), leaked }).toEqual({ secret: secret.slice(0, 12), leaked: false });
    }
    // And none in the evidence either.
    const [row] = (await app.get(DataSource).query(`SELECT string_agg(p::text, '\n') AS everything FROM provider_calls p WHERE provider = 'exchange-rate-api'`)) as { everything: string }[];
    expect(row.everything).toContain('/v6/[REDACTED]/latest/USD');
    expect(row.everything).not.toContain(API_KEY);
  });
});
