import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { DataSource } from 'typeorm';
import { FlowResumer } from '../../src/modules/flows/flow-resumer';
import { OutboxPoller } from '../../src/modules/outbox/outbox-poller';
import { WebhookProcessor } from '../../src/modules/payments/webhooks/webhook-processor';
import { ReservationSweeper } from '../../src/modules/reservations/reservation-sweeper';
import { WorkerModule } from '../../src/worker.module';
import { TestDatabase, startTestDatabase } from '../support/test-database';

/**
 * The worker process as `worker.ts` builds it: every loop resolves from `WorkerModule`,
 * runs, and stops gracefully; the reservation sweeper really expires overdue holds.
 */
describe('worker (integration)', () => {
  let db: TestDatabase;
  let redis: StartedRedisContainer;
  let worker: INestApplicationContext;

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine').start();
    db = await startTestDatabase({
      REDIS_URL: redis.getConnectionUrl(),
      FLOW_POLL_INTERVAL_MILLISECONDS: '50',
      OUTBOX_POLL_INTERVAL_MS: '50',
      RESERVATION_SWEEP_INTERVAL_MILLISECONDS: '100',
    });
    worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(db.env), { logger: false });
  });
  afterAll(async () => {
    await worker?.close();
    await db?.stop();
    await redis?.stop();
  });

  it('runs the outbox, the flow resumer, the webhook processor and the sweeper — and stops them gracefully', async () => {
    const dataSource = worker.get(DataSource);
    // An overdue ACTIVE reservation for the sweeper to find (its flow is a real flow row).
    const [user] = (await dataSource.query(
      `INSERT INTO users (email, password_hash) VALUES ('worker@example.com', '$argon2id$v=19$m=19456,t=2,p=1$aGFybmVzcw$aGFybmVzcw') RETURNING id`,
    )) as { id: string }[];
    const [wallet] = (await dataSource.query(`INSERT INTO wallets (user_id) VALUES ($1) RETURNING id`, [user.id])) as { id: string }[];
    const [account] = (await dataSource.query(
      `INSERT INTO accounts (code, account_type, normal_side, currency_code, authorizes_balance, wallet_id)
       VALUES ($1, 'LIABILITY', 'CREDIT', 'NGN', TRUE, $2) RETURNING id`,
      [`USER:${wallet.id}:NGN`, wallet.id],
    )) as { id: string }[];
    const [flow] = (await dataSource.query(
      `INSERT INTO flow_instances (flow_type, state, user_id, completed_at) VALUES ('FUNDING', 'FAILED', $1, now()) RETURNING id`,
      [user.id],
    )) as { id: string }[];
    const owner = await db.ownerClient();
    try {
      // Created already overdue (the service refuses a past expiry; this is a hold whose time ran out).
      await owner.query(`ALTER TABLE reservations DISABLE TRIGGER USER`);
      await owner.query(`UPDATE accounts SET reserved_minor = 1000 WHERE id = $1`, [account.id]);
      await owner.query(
        `INSERT INTO reservations (account_id, flow_id, amount_minor, expires_at) VALUES ($1, $2, 1000, now() - interval '1 minute')`,
        [account.id, flow.id],
      );
    } finally {
      await owner.query(`ALTER TABLE reservations ENABLE TRIGGER USER`);
      await owner.end();
    }

    const loops = [worker.get(OutboxPoller), worker.get(FlowResumer), worker.get(WebhookProcessor), worker.get(ReservationSweeper)];
    for (const loop of loops) loop.start();
    const deadline = Date.now() + 10_000;
    let status = 'ACTIVE';
    while (status === 'ACTIVE' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      [{ status }] = (await dataSource.query(`SELECT status FROM reservations WHERE flow_id = $1`, [flow.id])) as { status: string }[];
    }
    expect(status).toBe('EXPIRED');
    const [{ reserved }] = (await dataSource.query(`SELECT reserved_minor::text AS reserved FROM accounts WHERE id = $1`, [account.id])) as {
      reserved: string;
    }[];
    expect(reserved).toBe('0');

    const started = Date.now();
    await Promise.all(loops.map((loop) => loop.stop()));
    expect(Date.now() - started).toBeLessThan(2_000); // idle sleeps are interrupted, not waited out
  });
});
