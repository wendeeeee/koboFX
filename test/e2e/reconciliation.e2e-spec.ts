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
import { Clock } from '../../src/common/clock';
import { MockPsp } from '../../src/mock-psp/mock-psp';
import { FlowResumer } from '../../src/modules/flows/flow-resumer';
import { EmailSender } from '../../src/modules/notifications/email/email-sender';
import { OutboxDispatcher } from '../../src/modules/outbox/outbox-dispatcher';
import { WebhookProcessor } from '../../src/modules/payments/webhooks/webhook-processor';
import { dailyPeriodDue } from '../../src/modules/reconciliation/reconciliation-schedule';
import { ReconciliationScheduler } from '../../src/modules/reconciliation/reconciliation-scheduler';
import { CapturingEmailSender, TestClock } from '../support/auth-test-doubles';
import { paymentProviderTestSecrets } from '../support/authentication-secrets';
import { TestDatabase, startTestDatabase } from '../support/test-database';

const PASSWORD = 'an end-to-end reconciliation password';
const TOKEN = 'tok_success_reconciliation_card';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/**
 * register → verify → fund (webhooks delivered over HTTP) → the PSP settles → the worker's
 * reconciliation scheduler runs on its own loop → clean. Then a funding whose capture webhook is
 * dropped and whose resumer is held off → the hourly sweep finds it, drives it, and records why —
 * through `configureApp()`, a listening server, Postgres, Redis and the simulated PSP, with the
 * worker's loops running and one clock shared by the app and the PSP.
 */
describe('reconciliation (e2e: worker loops, real HTTP webhooks, the simulated PSP)', () => {
  let db: TestDatabase;
  let redis: StartedRedisContainer;
  let psp: MockPsp;
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let dropWebhooks = false;
  const clock = new TestClock();
  const emails = new CapturingEmailSender();
  const logLines: string[] = [];
  const secrets = new Set<string>([PASSWORD, TOKEN]);
  const { secretKey, webhookSecret } = paymentProviderTestSecrets();
  let email = '';
  let access = '';
  const loops = new Map<string, { start(): void; stop(): Promise<void> }>();

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine').start();
    let webhookUrl = '';
    psp = new MockPsp({
      secretKey,
      webhookSecret,
      // Slow enough that the test can drop the capture webhook in the second scenario.
      captureCompletion: { afterMilliseconds: 1500 },
      autoDeliverWebhooks: true,
      now: () => clock.now(),
      deliverWebhook: async (body, headers) => (dropWebhooks ? 202 : (await fetch(webhookUrl, { method: 'POST', body, headers })).status),
    });
    const pspUrl = await psp.start();
    db = await startTestDatabase({
      REDIS_URL: redis.getConnectionUrl(),
      LOG_LEVEL: 'debug',
      PSP_BASE_URL: pspUrl,
      FLOW_POLL_INTERVAL_MILLISECONDS: '100',
      RECONCILIATION_TICK_MILLISECONDS: '200',
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
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    webhookUrl = `http://127.0.0.1:${port}${PSP_WEBHOOK_PATH}`;
    dataSource = app.get(DataSource);
    // The worker's loops (worker.ts), against the same database.
    loops.set('resumer', app.get(FlowResumer)).set('processor', app.get(WebhookProcessor)).set('reconciliation', app.get(ReconciliationScheduler));
    for (const loop of loops.values()) loop.start();
    secrets.add(secretKey).add(webhookSecret.toString('base64')).add(webhookSecret.toString('hex'));
  });

  afterAll(async () => {
    await Promise.all([...loops.values()].map((loop) => loop.stop()));
    await app?.close();
    await psp?.stop();
    await db?.stop();
    await redis?.stop();
  });

  const http = () => request(app.getHttpServer());

  async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMilliseconds = 30_000): Promise<T> {
    const deadline = Date.now() + timeoutMilliseconds;
    let value = await read();
    while (!done(value) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      value = await read();
    }
    return value;
  }

  async function logIn(): Promise<void> {
    const session = await http().post(`/${API_PREFIX}/auth/login`).send({ email, password: PASSWORD }).expect(200);
    access = session.body.tokens.access.token as string;
    secrets.add(access).add(session.body.tokens.refresh.token as string);
  }

  async function fund(amount: string): Promise<string> {
    const accepted = await http()
      .post(`/${API_PREFIX}/wallet/fund`)
      .set('Authorization', `Bearer ${access}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount, currency: 'NGN', paymentMethodToken: TOKEN })
      .expect(202);
    return accepted.body.fundingId as string;
  }

  const runsOf = (kind: string) =>
    dataSource.query(`SELECT id, period_key, status::text AS status FROM reconciliation_runs WHERE kind = $1 ORDER BY period_key`, [kind]) as Promise<
      { id: string; period_key: string; status: string }[]
    >;
  const flowState = async (flowId: string) =>
    ((await dataSource.query(`SELECT state FROM flow_instances WHERE id = $1`, [flowId])) as { state: string }[])[0].state;

  it('register → verify → fund → the PSP settles → the scheduled runs reconcile it CLEAN', async () => {
    email = `reconciliation-e2e-${randomUUID().slice(0, 8)}@example.com`;
    await http().post(`/${API_PREFIX}/auth/register`).send({ email, password: PASSWORD }).expect(201);
    await app.get(OutboxDispatcher).dispatchDue(100);
    const code = emails.latestCodeFor(email);
    secrets.add(code);
    await http().post(`/${API_PREFIX}/auth/verify`).send({ email, password: PASSWORD, oneTimePassword: code }).expect(200);
    await logIn();

    const fundingId = await fund('325000');
    const funded = await eventually(
      async () => (await http().get(`/${API_PREFIX}/wallet/fund/${fundingId}`).set('Authorization', `Bearer ${access}`).expect(200)).body,
      (view: { status: string }) => view.status === 'COMPLETED',
    );
    expect(funded.status).toBe('COMPLETED');

    // T+2: the PSP pays it out; the worker's scheduler sees a new day and runs.
    clock.advance(2 * DAY + 3 * HOUR);
    psp.settle({ currency: 'NGN' });
    const settled = await eventually(() => flowState(fundingId), (state) => state === 'SETTLED');
    expect(settled).toBe('SETTLED');
    const daily = await eventually(
      () => runsOf('EXTERNAL_DAILY'),
      (runs) => runs.some((run) => run.status === 'CLEAN' && run.period_key === dailyPeriodDue(clock.now(), { hour: 2, minute: 0 })),
    );
    expect(daily.filter((run) => run.status === 'RUNNING')).toEqual([]);
    const internal = await eventually(
      () => runsOf('INTERNAL'),
      (runs) => runs.some((run) => run.status !== 'RUNNING' && run.period_key === dailyPeriodDue(clock.now(), { hour: 1, minute: 0 })),
    );
    expect(internal.at(-1)?.status).toBe('CLEAN');
    const [{ breaks }] = (await dataSource.query(`SELECT count(*)::int AS breaks FROM reconciliation_breaks`)) as { breaks: number }[];
    expect(breaks).toBe(0);
  });

  it('a capture webhook that is dropped while the resumer is held off: the hourly sweep finds it, drives it, and records why', async () => {
    await logIn(); // the clock moved days
    const fundingId = await fund('118000');
    // Let the resumer take it as far as "capture requested", then hold the worker off.
    await eventually(
      async () => (await dataSource.query(`SELECT capture_requested_at FROM funding_payments WHERE flow_id = $1`, [fundingId])) as { capture_requested_at: Date | null }[],
      (rows) => rows[0]?.capture_requested_at !== null,
    );
    dropWebhooks = true; // the PSP's "captured" webhook is lost
    await loops.get('resumer')!.stop();
    await loops.get('processor')!.stop();
    await eventually(async () => psp.paymentByReference(fundingId) as { status: string }, (payment) => payment.status === 'captured');
    expect(await flowState(fundingId)).toBe('AUTHORIZED');

    // An hour and more passes; only the reconciliation loop is running.
    clock.advance(2 * HOUR);
    const found = await eventually(
      async () =>
        (await dataSource.query(`SELECT id, type::text AS type, status::text AS status, resolution_kind, resolution_reference FROM reconciliation_breaks WHERE flow_id = $1`, [
          fundingId,
        ])) as { id: string; type: string; status: string; resolution_kind: string | null; resolution_reference: string | null }[],
      (rows) => rows[0]?.status === 'RESOLVED',
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ type: 'MISSING_IN_LEDGER', status: 'RESOLVED', resolution_kind: 'FLOW_ADVANCED' });
    expect(await flowState(fundingId)).toBe('POSTED');

    // The user's balance and history are right.
    await logIn();
    const wallet = await http().get(`/${API_PREFIX}/wallet`).set('Authorization', `Bearer ${access}`).expect(200);
    expect(wallet.body.balances).toEqual([{ currency: 'NGN', minorUnit: 2, total: '443000', reserved: '0', available: '443000' }]);
    const item = await http().get(`/${API_PREFIX}/transactions/funding:${fundingId}`).set('Authorization', `Bearer ${access}`).expect(200);
    expect(item.body).toMatchObject({ reference: `funding:${fundingId}`, type: 'FUNDING', status: 'COMPLETED' });
    expect(found[0].resolution_reference).toBe(
      ((await dataSource.query(`SELECT funding_transaction_id FROM funding_payments WHERE flow_id = $1`, [fundingId])) as { funding_transaction_id: string }[])[0]
        .funding_transaction_id,
    );

    // The audit trail records the detection and the resolution, by the job, with the cause.
    const audit = (await dataSource.query(`SELECT action, actor_type, after FROM audit_logs WHERE subject_id = $1 ORDER BY occurred_at`, [found[0].id])) as {
      action: string;
      actor_type: string;
      after: Record<string, string>;
    }[];
    expect(audit.map((row) => [row.action, row.actor_type])).toEqual([
      ['RECONCILIATION_BREAK_DETECTED', 'SYSTEM'],
      ['RECONCILIATION_BREAK_RESOLVED', 'SYSTEM'],
    ]);
    expect(audit[1].after).toMatchObject({ breakType: 'MISSING_IN_LEDGER', breakStatus: 'RESOLVED', resolutionKind: 'FLOW_ADVANCED' });
  });

  it('log hygiene: reconciliation logs ids and amounts — never an email, a secret, a token or card data', async () => {
    const log = logLines.join('');
    expect(log).toContain('Reconciliation break detected');
    expect(log).toContain('Settlement posted');
    for (const secret of secrets) {
      if (!secret) continue;
      const leaked = /^\d+$/.test(secret) ? new RegExp(`(?<!\\d)${secret}(?!\\d)`).test(log) : log.includes(secret);
      expect({ secret: secret.slice(0, 12), leaked }).toEqual({ secret: secret.slice(0, 12), leaked: false });
    }
    const reconciliationLines = logLines.filter((line) => /Reconciliation|Settlement|reconciliation/.test(line));
    expect(reconciliationLines.length).toBeGreaterThan(0);
    for (const line of reconciliationLines) expect(line).not.toContain(email);
    expect(log).not.toMatch(/"last4"|"exp_year"|4242 ?4242/);
    // The settlement's log line carries the amounts (strings) and ids.
    const settlementLine = logLines.find((line) => line.includes('Settlement posted'))!;
    expect(settlementLine).toMatch(/"batchId":"stl_[0-9a-f]+"/);
    expect(settlementLine).toMatch(/"grossMinor":"325000"/);
  });
});
