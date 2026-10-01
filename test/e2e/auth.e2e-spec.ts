import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { AppModule } from '../../src/app.module';
import { API_PREFIX, configureApp } from '../../src/app.setup';
import { IS_PUBLIC_KEY } from '../../src/common/decorators';
import { PasswordHasher } from '../../src/modules/auth/passwords/password-hasher';
import { OutboxDispatcher } from '../../src/modules/outbox/outbox-dispatcher';
import { RedisService } from '../../src/redis/redis.service';
import { TestDatabase, startTestDatabase } from '../support/test-database';

const PASSWORD = 'an end-to-end password';

/** Everything that must never reach a log line, collected as the flow produces it. */
const secrets = new Set<string>([PASSWORD]);

describe('authentication (e2e: real pipeline, Postgres, Redis, MailHog)', () => {
  let db: TestDatabase;
  let redis: StartedRedisContainer;
  let mailhog: StartedTestContainer;
  let app: NestExpressApplication;
  const logLines: string[] = [];

  beforeAll(async () => {
    [redis, mailhog] = await Promise.all([
      new RedisContainer('redis:7-alpine').start(),
      new GenericContainer('mailhog/mailhog:v1.0.1')
        .withExposedPorts(1025, 8025)
        .withWaitStrategy(Wait.forListeningPorts())
        .start(),
    ]);
    db = await startTestDatabase({
      REDIS_URL: redis.getConnectionUrl(),
      SMTP_HOST: mailhog.getHost(),
      SMTP_PORT: String(mailhog.getMappedPort(1025)),
      LOG_LEVEL: 'debug',
    });
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        logLines.push(chunk.toString('utf8'));
        done();
      },
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(db.env, { logStream })] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await db?.stop();
    await Promise.all([redis?.stop(), mailhog?.stop()]);
  });

  const http = () => request(app.getHttpServer());
  const newEmail = () => `e2e-${randomUUID().slice(0, 8)}@example.com`;

  /** The worker's job, run in-process, then read the code back out of MailHog's API. */
  async function codeFromMailbox(email: string): Promise<string> {
    await app.get(OutboxDispatcher).dispatchDue(100);
    const url = `http://${mailhog.getHost()}:${mailhog.getMappedPort(8025)}/api/v2/search?kind=to&query=${encodeURIComponent(email)}`;
    const found = (await (await fetch(url)).json()) as { items: { Content: { Body: string } }[] };
    const bodies = found.items.map((item) => item.Content.Body.replace(/=\r?\n/g, ''));
    const code = bodies.map((body) => /verification code is (\d{6})\./.exec(body)?.[1]).find(Boolean);
    if (!code) throw new Error(`No verification email for ${email} in MailHog`);
    secrets.add(code);
    return code;
  }

  async function registerAndVerify(email = newEmail()): Promise<{ email: string; access: string; refresh: string }> {
    await http().post(`/${API_PREFIX}/auth/register`).send({ email, password: PASSWORD }).expect(201);
    const verified = await http()
      .post(`/${API_PREFIX}/auth/verify`)
      .send({ email, password: PASSWORD, oneTimePassword: await codeFromMailbox(email) })
      .expect(200);
    const tokens = { access: verified.body.tokens.access.token as string, refresh: verified.body.tokens.refresh.token as string };
    secrets.add(tokens.access).add(tokens.refresh);
    return { email, ...tokens };
  }

  it('register → OTP by email → verify → protected route → refresh → logout → old tokens refused', async () => {
    const email = newEmail();
    const registered = await http().post(`/${API_PREFIX}/auth/register`).send({ email, password: PASSWORD }).expect(201);
    expect(registered.body).toEqual({ message: expect.any(String) });
    expect(JSON.stringify(registered.body)).not.toMatch(/\d{6}/);

    // Unverified: no session yet — the same generic 401 as a wrong password.
    const early = await http().post(`/${API_PREFIX}/auth/login`).send({ email, password: PASSWORD }).expect(401);
    expect(early.body.code).toBe('INVALID_CREDENTIALS');

    const code = await codeFromMailbox(email);
    const verified = await http()
      .post(`/${API_PREFIX}/auth/verify`)
      .send({ email, password: PASSWORD, oneTimePassword: code })
      .expect(200);
    expect(verified.body).toMatchObject({
      user: { email, status: 'ACTIVE', role: 'USER', verifiedAt: expect.any(String) },
      tokens: { tokenType: 'Bearer', access: { token: expect.any(String) }, refresh: { token: expect.any(String) } },
    });
    expect(verified.body.user).not.toHaveProperty('passwordHash');
    const access = verified.body.tokens.access.token as string;
    const refresh = verified.body.tokens.refresh.token as string;
    secrets.add(access).add(refresh);

    const me = await http().get(`/${API_PREFIX}/users/me`).set('Authorization', `Bearer ${access}`).expect(200);
    expect(me.body).toMatchObject({ email, status: 'ACTIVE' });

    const refreshed = await http().post(`/${API_PREFIX}/auth/refresh`).send({ refreshToken: refresh }).expect(200);
    const newAccess = refreshed.body.tokens.access.token as string;
    const newRefresh = refreshed.body.tokens.refresh.token as string;
    secrets.add(newAccess).add(newRefresh);
    await http().get(`/${API_PREFIX}/users/me`).set('Authorization', `Bearer ${newAccess}`).expect(200);

    await http().post(`/${API_PREFIX}/auth/logout`).set('Authorization', `Bearer ${newAccess}`).expect(204);
    for (const token of [access, newAccess]) {
      const refused = await http().get(`/${API_PREFIX}/users/me`).set('Authorization', `Bearer ${token}`).expect(401);
      expect(refused.body.code).toBe('UNAUTHENTICATED');
    }
    for (const token of [refresh, newRefresh]) {
      await http().post(`/${API_PREFIX}/auth/refresh`).send({ refreshToken: token }).expect(401);
    }
  });

  describe('enumeration resistance', () => {
    it('register answers byte-identically for an existing and an unknown email', async () => {
      const { email } = await registerAndVerify();
      // Let the per-email cooldown from that registration lapse (it applies to any
      // email, existing or not, so it reveals nothing — but it is not what's under test).
      const redisClient = app.get(RedisService).client;
      const cooldowns = await redisClient.keys('rate-limit:verification-email-cooldown:*');
      if (cooldowns.length > 0) await redisClient.del(...cooldowns);
      const existing = await http().post(`/${API_PREFIX}/auth/register`).send({ email, password: 'some other password' });
      const unknown = await http().post(`/${API_PREFIX}/auth/register`).send({ email: newEmail(), password: 'some other password' });
      expect(existing.status).toBe(unknown.status);
      expect(existing.text).toBe(unknown.text);
    });

    it('login answers identically for an unknown email, a wrong password and an unverified account — and does the same argon2 work', async () => {
      const { email } = await registerAndVerify();
      const unverified = newEmail();
      await http().post(`/${API_PREFIX}/auth/register`).send({ email: unverified, password: PASSWORD }).expect(201);
      const hasher = app.get(PasswordHasher);
      const verify = jest.spyOn(hasher, 'verify');
      const correlationId = 'enumeration-probe-0001';
      const attempt = async (body: object) => {
        verify.mockClear();
        const response = await http().post(`/${API_PREFIX}/auth/login`).set('X-Correlation-Id', correlationId).send(body);
        const hashes = verify.mock.calls.map(([hash]) => hash.replace(/\$[^$]+\$[^$]+$/, ''));
        return { status: response.status, body: { ...response.body, timestamp: 'removed' }, hashes };
      };
      const unknownEmail = await attempt({ email: newEmail(), password: PASSWORD });
      const wrongPassword = await attempt({ email, password: 'not the right password' });
      const notVerified = await attempt({ email: unverified, password: PASSWORD });
      for (const outcome of [unknownEmail, wrongPassword, notVerified]) {
        expect(outcome.status).toBe(401);
        expect(outcome.body).toEqual(unknownEmail.body);
        // Exactly one argon2id verification, with the same parameters, on every path.
        expect(outcome.hashes).toEqual(['$argon2id$v=19$m=19456,p=1,t=2']);
      }
      verify.mockRestore();
    });
  });

  it('rate limits answer 429 RATE_LIMITED with Retry-After (login: 5 per 15 minutes per IP and email)', async () => {
    const email = newEmail();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await http().post(`/${API_PREFIX}/auth/login`).send({ email, password: 'wrong password 123' }).expect(401);
    }
    const limited = await http().post(`/${API_PREFIX}/auth/login`).send({ email, password: 'wrong password 123' }).expect(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    const retryAfter = Number(limited.header['retry-after']);
    expect(retryAfter).toBeGreaterThan(800);
    expect(retryAfter).toBeLessThanOrEqual(900);
    // Casing is not a way around it.
    await http().post(`/${API_PREFIX}/auth/login`).send({ email: email.toUpperCase(), password: 'x' }).expect(429);
  });

  it('deny by default: every route not marked @Public() refuses a request without a token (enumerated from the router)', async () => {
    const reflector = app.get(Reflector);
    const scanner = new MetadataScanner();
    const routes: { method: string; path: string; isPublic: boolean }[] = [];
    for (const module of app.get(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype as new (...args: never[]) => object;
        const prototype = controller.prototype as Record<string, (...args: never[]) => unknown>;
        const controllerPath = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
        for (const name of scanner.getAllMethodNames(prototype)) {
          const handler = prototype[name];
          const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
          if (methodPath === undefined) continue;
          const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number].toLowerCase();
          const path = `/${[API_PREFIX, controllerPath, methodPath].map((part) => part.replace(/^\/|\/$/g, '')).filter(Boolean).join('/')}`;
          routes.push({ method, path, isPublic: reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, controller]) === true });
        }
      }
    }

    // Cross-check: every route Express actually serves was enumerated.
    const expressApp = app.getHttpAdapter().getInstance() as { router?: { stack: unknown[] }; _router?: { stack: unknown[] } };
    const served = (expressApp.router ?? expressApp._router)!.stack
      .map((layer) => (layer as { route?: { path: string; methods: Record<string, boolean> } }).route)
      .filter((route): route is { path: string; methods: Record<string, boolean> } => route !== undefined)
      // Nest's own not-found fallback (registered for every method) is not an application route.
      .filter((route) => route.path !== `/${API_PREFIX}$` && route.path !== `/${API_PREFIX}/{*path}`)
      .flatMap((route) => Object.keys(route.methods).map((method) => `${method} ${route.path}`));
    // The OpenAPI docs (Phase 11) are plain Express routes, public by design: they serve the contract, never data. Pinned
    // exactly, so any OTHER route outside the guard chain still fails here.
    const isDocs = (route: string) => route.split(' ')[1]!.startsWith(`/${API_PREFIX}/docs`);
    expect(served.filter(isDocs).sort()).toEqual(
      [
        `get /${API_PREFIX}/docs`,
        `get /${API_PREFIX}/docs/`,
        `get /${API_PREFIX}/docs/LICENSE`,
        `get /${API_PREFIX}/docs/docs/swagger-ui-init.js`,
        `get /${API_PREFIX}/docs/index.html`,
        `get /${API_PREFIX}/docs/swagger-ui-init.js`,
        `get /${API_PREFIX}/docs-json`,
      ].sort(),
    );
    expect(served.filter((route) => !isDocs(route)).sort()).toEqual(routes.map((route) => `${route.method} ${route.path}`).sort());

    expect(routes.filter((route) => route.isPublic).map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'get /api/v1/health/live',
      'get /api/v1/health/ready',
      'post /api/v1/auth/login',
      'post /api/v1/auth/refresh',
      'post /api/v1/auth/register',
      'post /api/v1/auth/resend-otp',
      'post /api/v1/auth/verify',
      // The only non-auth public route: authenticated by its HMAC signature instead (design §7.3).
      'post /api/v1/webhooks/psp',
    ]);
    const protectedRoutes = routes.filter((route) => !route.isPublic);
    expect(protectedRoutes.length).toBeGreaterThan(0);
    for (const route of protectedRoutes) {
      const path = route.path.replace(/:[^/]+/g, randomUUID());
      const response = await (http() as unknown as Record<string, (url: string) => request.Test>)[route.method](path);
      expect({ route: `${route.method} ${route.path}`, status: response.status, code: response.body.code }).toEqual({
        route: `${route.method} ${route.path}`,
        status: 401,
        code: 'UNAUTHENTICATED',
      });
    }
  });

  it('log hygiene: no password, one-time password, token or Authorization value in any log line of the whole run', async () => {
    // Also push a bearer header and a body with every sensitive field through the pipeline.
    await http()
      .post(`/${API_PREFIX}/auth/verify`)
      .set('Authorization', 'Bearer header.value.secret')
      .send({ email: newEmail(), password: PASSWORD, oneTimePassword: '999999' });
    secrets.add('header.value.secret');
    const log = logLines.join('');
    expect(log.length).toBeGreaterThan(1000); // the flow really was logged
    expect(log).toContain('[REDACTED]'); // the authorization header was seen and redacted
    for (const secret of secrets) {
      // A 6-digit code could occur by chance inside a longer number (a timestamp):
      // match all-digit secrets only as a standalone number.
      const leaked = /^\d+$/.test(secret) ? new RegExp(`(?<!\\d)${secret}(?!\\d)`).test(log) : log.includes(secret);
      expect({ secret: secret.slice(0, 12), leaked }).toEqual({ secret: secret.slice(0, 12), leaked: false });
    }
    expect(log).not.toMatch(/\$argon2id\$/);
  });
});
