import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import SwaggerParser from '@apidevtools/swagger-parser';
import { NestExpressApplication } from '@nestjs/platform-express';
import { OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { API_PREFIX, configureApp } from '../../src/app.setup';
import { buildOpenApiDocument } from '../../src/openapi/openapi-document';
import { signPaystackWebhook } from '../../src/modules/payments/paystack/webhooks/paystack-webhook-signature';
import { Administrators, FxHarness, HARNESS_USER_PASSWORD, LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';
import { OpenApiValidator, documentedCodes, matchOperation } from '../support/openapi-validation';

/**
 * The OpenAPI contract against the running application (Phase 11 plan §J). The document is built from the booted
 * `AppModule`; every claim it makes is checked against the app's BEHAVIOUR (not against the metadata it was built
 * from): the router's routes, what a request without a token / key / role actually gets, real response bodies
 * (validated CLOSED: no undocumented field, no documented-but-absent required field), and the committed
 * `docs/openapi.json` (`UPDATE_OPENAPI=1` rewrites it).
 */
const COMMITTED_SPEC = join(__dirname, '../../docs/openapi.json');
const PREFIX = `/${API_PREFIX}`;

type Json = Record<string, unknown>;
type Operation = { path: string; method: string; operation: Json };

describe('OpenAPI contract (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let fx: FxHarness;
  let app: NestExpressApplication;
  let document: OpenAPIObject;
  let validator: OpenApiValidator;
  let alice: SignedUpUser;
  let administrators: Administrators;
  let secondAdmin: SignedUpUser;

  const http = () => request(app.getHttpServer());
  const operations = (): Operation[] =>
    Object.entries(document.paths).flatMap(([path, item]) =>
      Object.entries(item as Json)
        .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
        .map(([method, operation]) => ({ path, method, operation: operation as Json })),
    );
  /** A concrete URL for a documented path: ids are fresh UUIDs, references `funding:{uuid}`. */
  const concrete = (path: string) => path.replace(/\{reference\}/g, `funding:${randomUUID()}`).replace(/\{[^}]+\}/g, () => randomUUID());
  const send = (method: string, url: string) => (http() as unknown as Record<string, (url: string) => request.Test>)[method](url);
  const tokenFor = (role: string): SignedUpUser => (role === 'ADMIN' ? administrators.admin : role === 'SECURITY' ? administrators.security : alice);
  /** Validate a real response against the document (closed), including that an error's code is documented for the route. */
  const expectDocumented = (method: string, url: string, response: request.Response) => {
    validator.assertResponse(method, url, response.status, response.status === 204 ? undefined : response.body);
  };

  beforeAll(async () => {
    harness = await startLedgerHarness(
      {
        CONVERSION_LIMITS: JSON.stringify({
          NGN: { maximum: '1000000000', dailyMaximum: '1500000000' },
          USD: { maximum: '1000000', dailyMaximum: '5000000' },
          EUR: { maximum: '1000000', dailyMaximum: '5000000' },
          GBP: { maximum: '1000000', dailyMaximum: '5000000' },
        }),
      },
      { fx: true, paystack: true },
    );
    payments = harness.payments!;
    fx = harness.fx!;
    app = harness.auth!.app;
    document = buildOpenApiDocument(app);
    validator = new OpenApiValidator(document);
    alice = await payments.signUp();
    administrators = await payments.admin.bootstrap();
    secondAdmin = await payments.admin.grant('ADMIN', administrators.admin, administrators.security);
    await fx.warm();
  }, 240_000);

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await payments.clearRateLimits();
  });

  describe('the document', () => {
    it('documents exactly the routes the router serves under the prefix (method and path), and nothing else', () => {
      const expressApp = app.getHttpAdapter().getInstance() as { router?: { stack: unknown[] }; _router?: { stack: unknown[] } };
      const stack = (expressApp.router ?? expressApp._router)!.stack as { route?: { path: string; methods: Record<string, boolean> } }[];
      const served = stack
        // `{*path}` is the request logger's middleware mount (`LoggerModule.forRoutes`), and `/docs*` the docs themselves.
        .filter((layer) => layer.route && layer.route.path.startsWith(`${PREFIX}/`) && !layer.route.path.startsWith(`${PREFIX}/docs`) && !layer.route.path.includes('{*'))
        .flatMap((layer) =>
          Object.keys(layer.route!.methods)
            .filter((method) => method !== '_all')
            .map((method) => `${method.toUpperCase()} ${layer.route!.path.replace(/:([A-Za-z]+)/g, '{$1}')}`),
        );
      const documented = operations().map(({ method, path }) => `${method.toUpperCase()} ${path}`);
      expect([...documented].sort()).toEqual([...new Set(served)].sort());
      // +6 withdrawal routes (W3): banks, beneficiaries POST/GET/list, withdraw POST/GET — always served, refused while off.
      // +2 stash reads (W4): GET /stash, GET /stash/transactions — always served.
      expect(documented).toHaveLength(46);
    });

    it('is a valid OpenAPI 3 document', async () => {
      const parsed = await SwaggerParser.validate(structuredClone(document) as never);
      expect((parsed as { openapi: string }).openapi).toMatch(/^3\./);
    });

    it('never types an amount as a number, anywhere (request, response, parameters, payloads)', () => {
      const amountName = /^(amount|total|reserved|available|balanceAfter|position|markedUsd|totalMarkedUsd|debits|credits|assets|liabilities|equity|revenue|expenses|drift)$|Amount$|Minor$/;
      const amounts: string[] = [];
      const offenders: string[] = [];
      const seen = new Set<unknown>();
      const walk = (node: unknown, where: string) => {
        if (typeof node !== 'object' || node === null || seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) return node.forEach((item, index) => walk(item, `${where}[${index}]`));
        const schema = node as Json;
        for (const [name, property] of Object.entries((schema.properties as Json | undefined) ?? {})) {
          if (amountName.test(name)) {
            amounts.push(`${where}.${name}`);
            const type = (property as Json).type;
            if (type === 'number' || type === 'integer' || (property as Json).$ref !== undefined) offenders.push(`${where}.${name} (${String(type ?? (property as Json).$ref)})`);
          }
        }
        for (const [key, value] of Object.entries(schema)) walk(value, `${where}.${key}`);
      };
      walk(document, '#');
      expect(offenders).toEqual([]);
      // The walker really saw them: wallet, fund, quote, convert, history, positions, payloads, parameters…
      expect(amounts.length).toBeGreaterThan(30);
    });

    it('matches the committed docs/openapi.json (UPDATE_OPENAPI=1 rewrites it)', () => {
      const generated = `${JSON.stringify(document, null, 2)}\n`;
      if (process.env.UPDATE_OPENAPI === '1') writeFileSync(COMMITTED_SPEC, generated);
      expect(existsSync(COMMITTED_SPEC)).toBe(true);
      expect(readFileSync(COMMITTED_SPEC, 'utf8')).toBe(generated);
    });

    it('describes every operation: a tag, a summary, a success response and the shared error schema', () => {
      const tags = new Set((document.tags ?? []).map((tag) => tag.name));
      for (const { method, path, operation } of operations()) {
        const where = `${method.toUpperCase()} ${path}`;
        expect({ where, tags: operation.tags }).toEqual({ where, tags: [expect.any(String)] });
        expect(tags.has((operation.tags as string[])[0] as string)).toBe(true);
        expect({ where, summary: typeof operation.summary }).toEqual({ where, summary: 'string' });
        const statuses = Object.keys(operation.responses as Json).map(Number);
        expect({ where, success: statuses.some((status) => status < 300) }).toEqual({ where, success: true });
        for (const status of statuses.filter((status) => status >= 400 && !(path.endsWith('/health/ready') && status === 503))) {
          expect({ where, status, codes: documentedCodes(operation, status).length > 0 }).toEqual({ where, status, codes: true });
        }
      }
    });
  });

  describe('security, idempotency and roles are what the app enforces', () => {
    it('no token: every bearer route answers 401 UNAUTHENTICATED; every public route does not ask for one', async () => {
      for (const { method, path, operation } of operations()) {
        await payments.clearRateLimits();
        const url = concrete(path);
        const response = await send(method, url).send(method === 'get' ? undefined : {});
        const security = operation.security as Json[];
        const where = `${method.toUpperCase()} ${path}`;
        if (security.some((requirement) => 'bearer' in requirement)) {
          expect({ where, status: response.status, code: response.body.code }).toEqual({ where, status: 401, code: 'UNAUTHENTICATED' });
          expectDocumented(method, url, response);
        } else if (security.some((requirement) => 'pspSignature' in requirement || 'paystackSignature' in requirement)) {
          expect({ where, status: response.status }).toEqual({ where, status: 401 });
          expectDocumented(method, url, response);
        } else {
          expect(security).toEqual([]);
          expect({ where, status: response.status }).not.toEqual({ where, status: 401 });
        }
      }
    });

    it('no Idempotency-Key: exactly the routes documented as idempotent refuse with 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
      const throwaway = await payments.signUp(); // logout revokes its session
      for (const { method, path, operation } of operations().filter(({ method }) => method !== 'get')) {
        await payments.clearRateLimits();
        const roles = (operation['x-roles'] as string[] | undefined) ?? [];
        const user = path.endsWith('/auth/logout') ? throwaway : roles.length > 0 ? tokenFor(roles[0] as string) : alice;
        const url = concrete(path);
        const response = await send(method, url).set('Authorization', `Bearer ${user.accessToken}`).send({});
        const where = `${method.toUpperCase()} ${path}`;
        const parameters = (operation.parameters as Json[] | undefined) ?? [];
        const declaresKey = parameters.some((parameter) => parameter.$ref === '#/components/parameters/IdempotencyKey');
        expect({ where, declaresKey }).toEqual({ where, declaresKey: operation['x-idempotent'] === true });
        if (operation['x-idempotent'] === true) {
          expect({ where, code: response.body.code }).toEqual({ where, code: 'IDEMPOTENCY_KEY_REQUIRED' });
          expectDocumented(method, url, response);
        } else {
          expect({ where, code: response.body?.code }).not.toEqual({ where, code: 'IDEMPOTENCY_KEY_REQUIRED' });
        }
      }
      const key = document.components!.parameters!.IdempotencyKey as unknown as Json;
      expect(key).toMatchObject({ in: 'header', name: 'Idempotency-Key', required: true, schema: { pattern: '^[A-Za-z0-9_-]{16,128}$' } });
    });

    it('roles: every /admin route states its roles, and exactly those roles get past the role check', async () => {
      const adminOperations = operations().filter(({ path }) => path.startsWith(`${PREFIX}/admin/`));
      expect(adminOperations).toHaveLength(16);
      for (const { method, path, operation } of adminOperations) {
        const roles = operation['x-roles'] as string[] | undefined;
        const where = `${method.toUpperCase()} ${path}`;
        expect({ where, hasRoles: Array.isArray(roles) && roles.length > 0 }).toEqual({ where, hasRoles: true });
        expect(roles).not.toContain('USER');
        expect(String(operation.description)).toContain(`**Roles:** ${roles!.join(', ')}.`);
        for (const role of ['USER', 'ADMIN', 'SECURITY']) {
          await payments.clearRateLimits();
          const url = concrete(path);
          const response = await send(method, url)
            .set('Authorization', `Bearer ${tokenFor(role).accessToken}`)
            .set('Idempotency-Key', randomUUID())
            .send({});
          const refusedByRole = response.status === 403 && response.body.code === 'FORBIDDEN';
          expect({ where, role, refusedByRole }).toEqual({ where, role, refusedByRole: !roles!.includes(role) });
          expectDocumented(method, url, response);
        }
      }
      for (const { method, path, operation } of operations().filter(({ path }) => !path.startsWith(`${PREFIX}/admin/`))) {
        expect({ where: `${method} ${path}`, roles: operation['x-roles'] }).toEqual({ where: `${method} ${path}`, roles: undefined });
      }
    });
  });

  describe('real responses match the documented schemas (closed)', () => {
    it('Paystack: pending, checkout, signed webhook, completed and unsigned refusal', async () => {
      const paystack = payments.paystack!;
      const user = await payments.signUp();
      const started = await paystack.fund(user, { amount: '150000', currency: 'NGN' }).expect(202);
      expectDocumented('post', `${PREFIX}/wallet/fund/paystack`, started);
      const fundingId = started.body.fundingId as string;
      const statusUrl = `${PREFIX}/wallet/fund/${fundingId}`;
      expectDocumented('get', statusUrl, await paystack.status(user, fundingId).expect(200));
      await payments.runner.advance(fundingId);
      const ready = await paystack.status(user, fundingId).expect(200);
      expect(ready.body.checkout.authorizationUrl).toEqual(expect.any(String));
      expectDocumented('get', statusUrl, ready);
      paystack.mock.pay(fundingId);
      const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: {
        id: paystack.mock.find(fundingId)!.id, status: 'success', reference: fundingId,
      } }));
      const webhookUrl = `${PREFIX}/webhooks/paystack`;
      const delivered = await http().post(webhookUrl).set('Content-Type', 'application/json')
        .set('X-Paystack-Signature', signPaystackWebhook(paystack.secretKey, body)).send(body.toString()).expect(200);
      expectDocumented('post', webhookUrl, delivered);
      await payments.drive();
      const completed = await paystack.status(user, fundingId).expect(200);
      expect(completed.body).toMatchObject({ status: 'COMPLETED', provider: 'paystack', checkout: null });
      expectDocumented('get', statusUrl, completed);
      expectDocumented('post', webhookUrl, await http().post(webhookUrl).send({}).expect(401));
    });

    it('auth: register 201, login 200, refresh 200, resend-otp 202, verify 400, logout 204', async () => {
      const email = `contract-${randomUUID().slice(0, 8)}@example.com`;
      expectDocumented('post', `${PREFIX}/auth/register`, await http().post(`${PREFIX}/auth/register`).send({ email, password: HARNESS_USER_PASSWORD }).expect(201));
      await payments.clearRateLimits(); // register and resend-otp share the per-email cooldown
      expectDocumented('post', `${PREFIX}/auth/resend-otp`, await http().post(`${PREFIX}/auth/resend-otp`).send({ email }).expect(202));
      expectDocumented(
        'post',
        `${PREFIX}/auth/verify`,
        await http().post(`${PREFIX}/auth/verify`).send({ email, password: HARNESS_USER_PASSWORD, oneTimePassword: '000000' }).expect(400),
      );
      const login = await http().post(`${PREFIX}/auth/login`).send({ email: alice.email, password: HARNESS_USER_PASSWORD }).expect(200);
      expectDocumented('post', `${PREFIX}/auth/login`, login);
      expectDocumented('post', `${PREFIX}/auth/login`, await http().post(`${PREFIX}/auth/login`).send({ email, password: 'wrong password entirely' }).expect(401));
      const refreshed = await http().post(`${PREFIX}/auth/refresh`).send({ refreshToken: login.body.tokens.refresh.token }).expect(200);
      expectDocumented('post', `${PREFIX}/auth/refresh`, refreshed);
      const logout = await http().post(`${PREFIX}/auth/logout`).set('Authorization', `Bearer ${refreshed.body.tokens.access.token}`).expect(204);
      expectDocumented('post', `${PREFIX}/auth/logout`, logout);
    });

    it('users, wallet, funding (202 → COMPLETED), rates, quote, convert, trade, history, and the 4xx bodies', async () => {
      const user = await payments.signUp();
      const auth = (test: request.Test) => test.set('Authorization', `Bearer ${user.accessToken}`);
      const check = async (method: string, url: string, test: request.Test, status: number) => {
        const response = await test;
        expect({ url, status: response.status, body: response.body }).toEqual({ url, status, body: response.body });
        expectDocumented(method, url, response);
        return response;
      };

      await check('get', `${PREFIX}/users/me`, auth(http().get(`${PREFIX}/users/me`)), 200);
      await check('get', `${PREFIX}/wallet`, auth(http().get(`${PREFIX}/wallet`)), 200);
      await check('get', `${PREFIX}/wallet`, http().get(`${PREFIX}/wallet`), 401);

      const funded = await check(
        'post',
        `${PREFIX}/wallet/fund`,
        payments.fund(user, { amount: '500000', currency: 'NGN', paymentMethodToken: 'tok_example_visa' }),
        202,
      );
      await check(
        'post',
        `${PREFIX}/wallet/fund`,
        payments.fund(user, { amount: 500000, currency: 'NGN', paymentMethodToken: 'tok_example_visa' } as never),
        400,
      );
      await check('post', `${PREFIX}/wallet/fund`, payments.fund(user, { amount: '1', currency: 'NGN', paymentMethodToken: 'tok_example_visa' }), 422);
      const fundingUrl = `${PREFIX}/wallet/fund/${funded.body.fundingId}`;
      await check('get', fundingUrl, auth(http().get(fundingUrl)), 200);
      await payments.drive();
      const completed = await check('get', fundingUrl, auth(http().get(fundingUrl)), 200);
      expect(completed.body.status).toBe('COMPLETED');
      await check('get', `${PREFIX}/wallet/fund/${randomUUID()}`, auth(http().get(`${PREFIX}/wallet/fund/${randomUUID()}`)), 404);

      await check('get', `${PREFIX}/fx/rates`, auth(http().get(`${PREFIX}/fx/rates`)), 200);
      const quote = await check(
        'post',
        `${PREFIX}/fx/quotes`,
        auth(http().post(`${PREFIX}/fx/quotes`)).set('Idempotency-Key', randomUUID()).send({ from: 'NGN', to: 'USD', sourceAmount: '100000' }),
        201,
      );
      await check('get', `${PREFIX}/fx/quotes/${quote.body.quoteId}`, auth(http().get(`${PREFIX}/fx/quotes/${quote.body.quoteId}`)), 200);
      await check(
        'post',
        `${PREFIX}/fx/quotes`,
        auth(http().post(`${PREFIX}/fx/quotes`)).set('Idempotency-Key', randomUUID()).send({ from: 'NGN', to: 'NGN', sourceAmount: '100000' }),
        400,
      );
      const traded = await check(
        'post',
        `${PREFIX}/wallet/trade`,
        auth(http().post(`${PREFIX}/wallet/trade`)).set('Idempotency-Key', randomUUID()).send({ quoteId: quote.body.quoteId }),
        201,
      );
      expect(traded.body.quoteId).toBe(quote.body.quoteId);
      await check(
        'post',
        `${PREFIX}/wallet/trade`,
        auth(http().post(`${PREFIX}/wallet/trade`)).set('Idempotency-Key', randomUUID()).send({ quoteId: quote.body.quoteId }),
        409,
      );
      const convertKey = randomUUID();
      const converted = await check(
        'post',
        `${PREFIX}/wallet/convert`,
        auth(http().post(`${PREFIX}/wallet/convert`)).set('Idempotency-Key', convertKey).send({ from: 'NGN', to: 'USD', sourceAmount: '100000' }),
        201,
      );
      const replay = await check(
        'post',
        `${PREFIX}/wallet/convert`,
        auth(http().post(`${PREFIX}/wallet/convert`)).set('Idempotency-Key', convertKey).send({ from: 'NGN', to: 'USD', sourceAmount: '100000' }),
        201,
      );
      expect(replay.header['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(converted.body);
      // §12.1's example code: more than the balance. A permanent refusal inside the barrier is stored and replayed.
      const refusedKey = randomUUID();
      const tooMuch = { from: 'NGN', to: 'USD', sourceAmount: '100000000' };
      const refused = await check('post', `${PREFIX}/wallet/convert`, auth(http().post(`${PREFIX}/wallet/convert`)).set('Idempotency-Key', refusedKey).send(tooMuch), 409);
      expect(refused.body.code).toBe('INSUFFICIENT_FUNDS');
      expect(refused.header['x-correlation-id']).toBe(refused.body.correlationId);
      const refusedAgain = await check('post', `${PREFIX}/wallet/convert`, auth(http().post(`${PREFIX}/wallet/convert`)).set('Idempotency-Key', refusedKey).send(tooMuch), 409);
      expect(refusedAgain.header['idempotent-replayed']).toBe('true');
      const convertResponses = matchOperation(document, 'post', `${PREFIX}/wallet/convert`).operation.responses as Record<string, { headers: Json }>;
      expect(convertResponses['409']!.headers).toHaveProperty('Idempotent-Replayed');
      // Refused before the barrier (a guard, the body parser): never stored, so never documented as replayed.
      expect(convertResponses['401']!.headers).not.toHaveProperty('Idempotent-Replayed');
      expect(convertResponses['413']!.headers).not.toHaveProperty('Idempotent-Replayed');

      const page = await check('get', `${PREFIX}/transactions`, auth(http().get(`${PREFIX}/transactions?limit=2`)), 200);
      expect(page.body.nextCursor).toEqual(expect.any(String));
      const all = await check('get', `${PREFIX}/transactions`, auth(http().get(`${PREFIX}/transactions`)), 200);
      for (const item of all.body.items as { reference: string }[]) {
        const url = `${PREFIX}/transactions/${item.reference}`;
        await check('get', url, auth(http().get(url)), 200);
      }
      expect((all.body.items as { type: string }[]).map((item) => item.type).sort()).toEqual(['CONVERSION', 'CONVERSION', 'FUNDING']);
      await check('get', `${PREFIX}/transactions`, auth(http().get(`${PREFIX}/transactions?cursor=garbage`)), 400);
      await check('get', `${PREFIX}/transactions/not-a-reference`, auth(http().get(`${PREFIX}/transactions/not-a-reference`)), 400);
      await check('get', `${PREFIX}/transactions/funding:${randomUUID()}`, auth(http().get(`${PREFIX}/transactions/funding:${randomUUID()}`)), 404);
      await check('get', `${PREFIX}/transactions/withdrawal:${randomUUID()}`, auth(http().get(`${PREFIX}/transactions/withdrawal:${randomUUID()}`)), 404);

      // The stash (W4): an unopened stash is a null id and NGN "0", read without a write.
      const stash = await check('get', `${PREFIX}/stash`, auth(http().get(`${PREFIX}/stash`)), 200);
      expect(stash.body).toEqual({ stashId: null, kind: 'SIMULATED_BANK', simulated: true, balances: [{ currency: 'NGN', minorUnit: 2, amount: '0' }] });
      const receipts = await check('get', `${PREFIX}/stash/transactions`, auth(http().get(`${PREFIX}/stash/transactions?currency=NGN&limit=5`)), 200);
      expect(receipts.body).toEqual({ stashId: null, kind: 'SIMULATED_BANK', simulated: true, items: [], nextCursor: null });
      await check('get', `${PREFIX}/stash/transactions`, auth(http().get(`${PREFIX}/stash/transactions?cursor=garbage`)), 400);
      await check('get', `${PREFIX}/stash/transactions`, auth(http().get(`${PREFIX}/stash/transactions?currency=XYZ`)), 400);
      await check('get', `${PREFIX}/stash`, http().get(`${PREFIX}/stash`), 401);
    });

    it('admin: request 201 → approve 200 EXECUTED, the reads, recertification', async () => {
      const target = await payments.signUp();
      const as = (user: SignedUpUser, test: request.Test) => test.set('Authorization', `Bearer ${user.accessToken}`);
      const check = async (method: string, url: string, test: request.Test, status: number) => {
        const response = await test;
        expect({ url, status: response.status, body: response.body }).toEqual({ url, status, body: response.body });
        expectDocumented(method, url, response);
        return response;
      };
      const requested = await check(
        'post',
        `${PREFIX}/admin/approvals`,
        as(administrators.admin, http().post(`${PREFIX}/admin/approvals`))
          .set('Idempotency-Key', randomUUID())
          .send({ actionType: 'SUSPEND_USER', payload: { userId: target.userId }, reason: 'contract test' }),
        201,
      );
      expect(requested.body.status).toBe('PENDING');
      const approvalUrl = `${PREFIX}/admin/approvals/${requested.body.approvalId}`;
      await check('post', `${approvalUrl}/approve`, as(administrators.admin, http().post(`${approvalUrl}/approve`)).set('Idempotency-Key', randomUUID()), 403);
      const approved = await check('post', `${approvalUrl}/approve`, as(secondAdmin, http().post(`${approvalUrl}/approve`)).set('Idempotency-Key', randomUUID()), 200);
      expect(approved.body.status).toBe('EXECUTED');
      await check('post', `${approvalUrl}/reject`, as(secondAdmin, http().post(`${approvalUrl}/reject`)).set('Idempotency-Key', randomUUID()).send({ reason: 'late' }), 409);
      await check('get', approvalUrl, as(administrators.security, http().get(approvalUrl)), 200);
      await check('get', `${PREFIX}/admin/approvals`, as(administrators.admin, http().get(`${PREFIX}/admin/approvals?limit=1`)), 200);
      await check(
        'post',
        `${PREFIX}/admin/approvals`,
        as(administrators.admin, http().post(`${PREFIX}/admin/approvals`))
          .set('Idempotency-Key', randomUUID())
          .send({ actionType: 'WRITE_OFF', payload: { userId: target.userId, currency: 'NGN', amount: 100, valueTime: '2026-09-29T00:00:00Z' }, reason: 'x' }),
        400,
      );
      for (const path of ['positions', 'breaks', 'reconciliation-runs', `users/${alice.userId}`, `users/${alice.userId}/transactions`]) {
        await check('get', `${PREFIX}/admin/${path}`, as(administrators.admin, http().get(`${PREFIX}/admin/${path}`)), 200);
      }
      const adminHistory = await as(administrators.admin, http().get(`${PREFIX}/admin/users/${alice.userId}/transactions`));
      for (const item of adminHistory.body.items as { reference: string }[]) {
        const url = `${PREFIX}/admin/users/${alice.userId}/transactions/${item.reference}`;
        await check('get', url, as(administrators.admin, http().get(url)), 200);
      }
      await check('get', `${PREFIX}/admin/users/${randomUUID()}`, as(administrators.admin, http().get(`${PREFIX}/admin/users/${randomUUID()}`)), 404);
      await check('get', `${PREFIX}/admin/recertification`, as(administrators.security, http().get(`${PREFIX}/admin/recertification`)), 200);
    });

    it('health: live and ready; the webhook: an unsigned event is a documented 401', async () => {
      expectDocumented('get', `${PREFIX}/health/live`, await http().get(`${PREFIX}/health/live`).expect(200));
      expectDocumented('get', `${PREFIX}/health/ready`, await http().get(`${PREFIX}/health/ready`).expect(200));
      const unsigned = await http().post(`${PREFIX}/webhooks/psp`).set('Content-Type', 'application/json').send('{"id":"evt_1","type":"payment.captured"}');
      expect(unsigned.status).toBe(401);
      expectDocumented('post', `${PREFIX}/webhooks/psp`, unsigned);
    });
  });

  describe('documented request examples are valid', () => {
    const NOT_VALID = ['VALIDATION_FAILED', 'INVALID_AMOUNT', 'SAME_CURRENCY', 'UNSUPPORTED_CURRENCY', 'UNSUPPORTED_CURRENCY_PAIR', 'IDEMPOTENCY_KEY_INVALID'];

    /** The examples a client sees: explicit body examples, else one synthesised from the schema's property examples. */
    const examplesOf = (operation: Json): Json[] => {
      const content = ((operation.requestBody as Json | undefined)?.content as Json | undefined)?.['application/json'] as Json | undefined;
      if (!content) return [];
      if (content.examples) return Object.values(content.examples as Record<string, { value: Json }>).map((example) => example.value);
      const reference = (content.schema as Json).$ref as string | undefined;
      const schema = (reference ? document.components!.schemas![reference.split('/').pop() as string] : content.schema) as Json;
      return [Object.fromEntries(Object.entries((schema.properties as Record<string, Json>) ?? {}).map(([name, property]) => [name, property.example]))];
    };

    it('every request example passes its route\'s own validation (sent through the real pipeline)', async () => {
      const user = await payments.signUp();
      const checked: string[] = [];
      for (const { method, path, operation } of operations().filter(({ path }) => !path.includes('/webhooks/'))) {
        for (const example of examplesOf(operation)) {
          await payments.clearRateLimits();
          const roles = (operation['x-roles'] as string[] | undefined) ?? [];
          const caller = roles.length > 0 ? tokenFor(roles[0] as string) : user;
          const url = concrete(path);
          const response = await send(method, url)
            .set('Authorization', `Bearer ${caller.accessToken}`)
            .set('Idempotency-Key', randomUUID())
            .send(example);
          const where = `${method.toUpperCase()} ${path} ${JSON.stringify(example)}`;
          expect({ where, code: NOT_VALID.includes(response.body?.code) ? response.body : 'valid' }).toEqual({ where, code: 'valid' });
          expectDocumented(method, url, response);
          checked.push(`${method} ${path}`);
        }
      }
      // auth ×5, fund, quote ×2, convert ×2, trade, approvals ×10 (W4: + PAYSTACK_WITHDRAWAL_RECOVERY), reject, review,
      // withdrawal beneficiary, withdraw.
      expect(checked.length).toBe(26);
    });

    it('every admin payload example matches its documented payload schema', () => {
      const body = ((matchOperation(document, 'post', `${PREFIX}/admin/approvals`).operation.requestBody as Json).content as Json)['application/json'] as Json;
      const requestSchema = validator.compile(body.schema);
      for (const [name, { value }] of Object.entries(body.examples as Record<string, { value: Json }>)) {
        expect({ name, valid: requestSchema(value), errors: requestSchema.errors }).toEqual({ name, valid: true, errors: null });
      }
    });
  });

  describe('serving the docs', () => {
    it('serves the UI and the JSON under the prefix; helmet\'s CSP applies unchanged and the UI needs no inline script', async () => {
      const json = await http().get(`${PREFIX}/docs-json`).expect(200);
      expect(json.body).toEqual(JSON.parse(JSON.stringify(document)));
      const ui = await http().get(`${PREFIX}/docs/`).expect(200);
      expect(ui.header['content-type']).toMatch(/text\/html/);
      const api = await http().get(`${PREFIX}/health/live`);
      expect(ui.header['content-security-policy']).toBeDefined();
      expect(ui.header['content-security-policy']).toBe(api.header['content-security-policy']);
      expect(ui.header['content-security-policy']).toContain("script-src 'self'");
      const html = ui.text;
      const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
      expect(scripts.length).toBeGreaterThan(0);
      for (const [, attributes, body] of scripts) {
        expect(attributes).toMatch(/src="(?!https?:|\/\/)[^"]+"/);
        expect((body ?? '').trim()).toBe('');
        const source = /src="([^"]+)"/.exec(attributes as string)![1] as string;
        await http().get(`${PREFIX}/docs/${source.replace(/^\.\//, '')}`).expect(200);
      }
    });

    it('the UI\'s init script parses and loads the document from /docs-json (it embeds nothing to corrupt)', async () => {
      // Descriptions quote regexes ending in `$` — the sequence @nestjs/swagger's string-replacement template corrupts.
      expect(JSON.stringify(document)).toContain('$`');
      for (const path of [`${PREFIX}/docs/swagger-ui-init.js`, `${PREFIX}/docs/docs/swagger-ui-init.js`]) {
        const script = await http().get(path).expect(200);
        expect(script.header['content-type']).toMatch(/javascript/);
        let options: { spec?: unknown; url?: string } | undefined;
        const window: Record<string, unknown> = { location: { search: '', origin: 'http://localhost' } };
        runInNewContext(`${script.text}\nwindow.onload();`, {
          window,
          SwaggerUIBundle: Object.assign(
            (given: { spec?: unknown; url?: string }) => {
              options = given;
              return { initOAuth: () => undefined };
            },
            { presets: { apis: {} }, plugins: { DownloadUrl: {} } },
          ),
          SwaggerUIStandalonePreset: {},
        });
        expect(options).toMatchObject({ spec: {}, url: `${PREFIX}/docs-json` });
        expect(Object.keys(options!.spec as Json)).toEqual([]);
      }
      // …and that URL serves the whole document.
      expect((await http().get(`${PREFIX}/docs-json`).expect(200)).body).toEqual(JSON.parse(JSON.stringify(document)));
    });

    it('serves nothing when API_DOCS_ENABLED=false (and the API itself is unchanged)', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot({ ...harness.db.env, API_DOCS_ENABLED: 'false' })] }).compile();
      const disabled = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
      configureApp(disabled);
      await disabled.init();
      try {
        await request(disabled.getHttpServer()).get(`${PREFIX}/docs-json`).expect(404);
        await request(disabled.getHttpServer()).get(`${PREFIX}/docs/`).expect(404);
        await request(disabled.getHttpServer()).get(`${PREFIX}/health/live`).expect(200);
      } finally {
        await disabled.close();
      }
    });
  });
});
