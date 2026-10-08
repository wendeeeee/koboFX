import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { API_PREFIX, PSP_WEBHOOK_PATH, configureApp } from '../../src/app.setup';
import { MockPsp } from '../../src/mock-psp/mock-psp';
import { FlowResumer } from '../../src/modules/flows/flow-resumer';
import { EmailSender } from '../../src/modules/notifications/email/email-sender';
import { OutboxDispatcher } from '../../src/modules/outbox/outbox-dispatcher';
import { WebhookProcessor } from '../../src/modules/payments/webhooks/webhook-processor';
import { CapturingEmailSender } from '../support/auth-test-doubles';
import { paymentProviderTestSecrets } from '../support/authentication-secrets';
import { TestDatabase, startTestDatabase } from '../support/test-database';

const PASSWORD = 'an end-to-end funding password';
const TOKEN = 'tok_success_e2e_card_token';

/**
 * register → verify → fund → (PSP captures, signs and POSTs its webhooks over real HTTP;
 * the worker's resumer and webhook processor run on their own loops) → GET /wallet —
 * through `configureApp()`, a real listening server, Postgres, Redis and the simulated PSP.
 */
describe('funding (e2e: real pipeline, real HTTP webhooks, worker loops running)', () => {
  let db: TestDatabase;
  let redis: StartedRedisContainer;
  let psp: MockPsp;
  let app: NestExpressApplication;
  let loops: { stop(): Promise<void> }[] = [];
  const emails = new CapturingEmailSender();
  const logLines: string[] = [];
  const secrets = new Set<string>([PASSWORD, TOKEN]);
  const { secretKey, webhookSecret } = paymentProviderTestSecrets();

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine').start();
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
    // The worker's loops (worker.ts), running against the same database.
    const resumer = app.get(FlowResumer);
    const processor = app.get(WebhookProcessor);
    resumer.start();
    processor.start();
    loops = [resumer, processor];
    secrets.add(secretKey).add(webhookSecret.toString('base64')).add(webhookSecret.toString('hex'));
  });

  afterAll(async () => {
    await Promise.all(loops.map((loop) => loop.stop()));
    await app?.close();
    await psp?.stop();
    await db?.stop();
    await redis?.stop();
  });

  const http = () => request(app.getHttpServer());

  async function registerAndVerify(): Promise<string> {
    const email = `funding-e2e-${randomUUID().slice(0, 8)}@example.com`;
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

  it('register → verify → fund → webhook → GET /wallet shows the credit; the same key replayed returns the original response', async () => {
    const access = await registerAndVerify();
    const key = randomUUID();
    const fundBody = { amount: '250000', currency: 'NGN', paymentMethodToken: TOKEN };
    const accepted = await http()
      .post(`/${API_PREFIX}/wallet/fund`)
      .set('Authorization', `Bearer ${access}`)
      .set('Idempotency-Key', key)
      .send(fundBody)
      .expect(202);
    expect(accepted.body).toEqual({ fundingId: expect.any(String), status: 'PENDING', amount: '250000', currency: 'NGN' });
    const fundingId = accepted.body.fundingId as string;

    const finished = await eventually(
      async () => (await http().get(`/${API_PREFIX}/wallet/fund/${fundingId}`).set('Authorization', `Bearer ${access}`).expect(200)).body,
      (view: { status: string }) => view.status !== 'PENDING',
    );
    expect(finished).toMatchObject({ fundingId, status: 'COMPLETED', transactionReference: `funding:${fundingId}` });

    const wallet = await http().get(`/${API_PREFIX}/wallet`).set('Authorization', `Bearer ${access}`).expect(200);
    expect(wallet.body).toEqual({ balances: [{ currency: 'NGN', minorUnit: 2, total: '250000', reserved: '0', available: '250000' }] });

    // The webhooks really arrived over HTTP, signed, and were processed as hints.
    const dataSource = app.get(DataSource);
    const events = await eventually(
      async () =>
        (await dataSource.query(`SELECT signature_valid, outcome, headers FROM webhook_events`)) as {
          signature_valid: boolean;
          outcome: string | null;
          headers: Record<string, string>;
        }[],
      (rows) => rows.length >= 3 && rows.every((row) => row.outcome !== null),
    );
    expect(events.every((event) => event.signature_valid)).toBe(true);
    for (const event of events) secrets.add(event.headers['x-psp-signature']);

    const replay = await http()
      .post(`/${API_PREFIX}/wallet/fund`)
      .set('Authorization', `Bearer ${access}`)
      .set('Idempotency-Key', key)
      .send(fundBody)
      .expect(202);
    expect(replay.text).toBe(accepted.text);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const [{ flows }] = (await dataSource.query(`SELECT count(*)::int AS flows FROM flow_instances`)) as { flows: number }[];
    expect(flows).toBe(1);
    expect(psp.statistics()).toMatchObject({ effectiveAuthorizations: 1, effectiveCaptures: 1 });
  });

  it('the webhook route reads raw bytes and verifies them; every other route keeps the JSON parser and the 100KB cap', async () => {
    const body = Buffer.from('{"id":"evt_e2e_raw","type":"payment.captured","data":{"object":{"id":"pay_x","reference":"r"}}}');
    const signature = psp.sign(body);
    secrets.add(signature);
    await http().post(PSP_WEBHOOK_PATH).set('Content-Type', 'application/json').set('X-Psp-Signature', signature).send(body.toString()).expect(202);
    // The same JSON with different whitespace is different bytes: refused.
    await http()
      .post(PSP_WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('X-Psp-Signature', signature)
      .send(JSON.stringify(JSON.parse(body.toString()), null, 2))
      .expect(401);
    // Any content type is taken raw on this route (what the PSP signed is what we verify).
    await http().post(PSP_WEBHOOK_PATH).set('Content-Type', 'text/plain').set('X-Psp-Signature', signature).send(body.toString()).expect(202);
    const tooBig = await http().post(`/${API_PREFIX}/auth/login`).set('Content-Type', 'application/json').send(`{"email":"${'a'.repeat(110 * 1024)}"}`);
    expect(tooBig.status).toBe(413);
    const bad = await http().post(`/${API_PREFIX}/auth/login`).set('Content-Type', 'application/json').send('{"email":');
    expect(bad.status).toBe(400);
  });

  it('log hygiene: no PSP secret, webhook secret or signature, payment token, card data or Authorization value in any log line', async () => {
    await http().get(`/${API_PREFIX}/wallet`).set('Authorization', 'Bearer header.value.secret').expect(401);
    secrets.add('header.value.secret');
    const log = logLines.join('');
    expect(log.length).toBeGreaterThan(1000);
    expect(log).toContain('[REDACTED]');
    for (const secret of secrets) {
      if (!secret) continue;
      const leaked = /^\d+$/.test(secret) ? new RegExp(`(?<!\\d)${secret}(?!\\d)`).test(log) : log.includes(secret);
      expect({ secret: secret.slice(0, 12), leaked }).toEqual({ secret: secret.slice(0, 12), leaked: false });
    }
    expect(log).not.toMatch(/"last4"|"exp_year"|4242 ?4242/);
  });
});
