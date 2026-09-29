import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { PSP_WEBHOOK_PATH } from '../../src/app.setup';
import { WebhookMetrics } from '../../src/modules/payments/webhooks/webhook-metrics';
import { signWebhook } from '../../src/modules/payments/webhooks/webhook-signature';
import { paymentProviderTestSecrets } from '../support/authentication-secrets';
import { LedgerHarness, PaymentsHarness, startLedgerHarness } from '../support/ledger-harness';

/** `POST /webhooks/psp` (design §7.3): verify raw bytes, persist verbatim, 202 fast, never trust content. */
describe('PSP webhooks (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  const { webhookSecret, secretKey } = paymentProviderTestSecrets();

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { payments: true });
    payments = harness.payments!;
  });
  afterAll(async () => harness?.close());
  beforeEach(() => {
    for (const event of payments.psp.pendingWebhooks()) payments.psp.drop(event.id);
  });

  const http = () => request(harness.auth!.app.getHttpServer());
  const now = () => Math.floor(Date.now() / 1000);
  const eventBody = (overrides: Record<string, unknown> = {}) =>
    Buffer.from(
      JSON.stringify({
        id: `evt_${randomUUID()}`,
        type: 'payment.captured',
        data: { object: { id: `pay_${randomBytes(6).toString('hex')}`, reference: randomUUID(), status: 'captured' } },
        ...overrides,
      }),
    );
  const deliver = (body: Buffer, signature: string | undefined) => {
    const call = http().post(PSP_WEBHOOK_PATH).set('Content-Type', 'application/json');
    return (signature ? call.set('X-Psp-Signature', signature) : call).send(body.toString('utf8'));
  };
  const eventRow = async (providerEventId: string) =>
    (await harness.dataSource.query(
      `SELECT id, signature_valid, outcome, processed_at, raw_payload, headers FROM webhook_events WHERE provider_event_id = $1 ORDER BY received_at`,
      [providerEventId],
    )) as { id: string; signature_valid: boolean; outcome: string | null; processed_at: Date | null; raw_payload: Buffer; headers: Record<string, string> }[];

  it('a valid delivery is stored verbatim (the exact bytes) and acknowledged 202', async () => {
    const body = eventBody();
    const { id } = JSON.parse(body.toString()) as { id: string };
    const response = await deliver(body, signWebhook(webhookSecret, body, now())).expect(202);
    expect(response.body).toEqual({ received: true });
    const [row] = await eventRow(id);
    expect(row.signature_valid).toBe(true);
    expect(Buffer.compare(row.raw_payload, body)).toBe(0);
    expect(Object.keys(row.headers).sort()).toEqual(['content-length', 'content-type', 'x-psp-signature']);
  });

  it('invalid signatures are stored with signature_valid = false, answered 401 generically, counted, and never processed', async () => {
    const metrics = harness.moduleRef.get(WebhookMetrics);
    const before = metrics.webhookSignatureInvalidTotal;
    const cases: [string, Buffer, string | undefined][] = [];
    const tampered = eventBody();
    cases.push(['wrong secret', eventBody(), signWebhook(randomBytes(32), eventBody(), now())]);
    cases.push(['tampered byte', tampered, signWebhook(webhookSecret, Buffer.from(tampered.toString().replace('captured', 'capturex')), now())]);
    const stale = eventBody();
    cases.push(['stale timestamp', stale, signWebhook(webhookSecret, stale, now() - 3600)]);
    cases.push(['missing header', eventBody(), undefined]);
    const reserialised = eventBody();
    cases.push(['re-serialised JSON', Buffer.from(JSON.stringify(JSON.parse(reserialised.toString()), null, 2)), signWebhook(webhookSecret, reserialised, now())]);

    for (const [name, body, signature] of cases) {
      const response = await deliver(body, signature);
      expect({ name, status: response.status, code: response.body.code, message: response.body.message }).toEqual({
        name,
        status: 401,
        code: 'UNAUTHENTICATED',
        message: 'Webhook signature verification failed.',
      });
    }
    expect(metrics.webhookSignatureInvalidTotal - before).toBe(cases.length);
    const invalid = (await harness.dataSource.query(
      `SELECT count(*)::int AS n FROM webhook_events WHERE NOT signature_valid AND outcome = 'INVALID_SIGNATURE' AND processed_at IS NOT NULL`,
    )) as { n: number }[];
    expect(invalid[0].n).toBeGreaterThanOrEqual(cases.length);
    await payments.processor.processDue(100);
    const claimedInvalid = (await harness.dataSource.query(
      `SELECT count(*)::int AS n FROM webhook_events WHERE NOT signature_valid AND attempts > 0`,
    )) as { n: number }[];
    expect(claimedInvalid[0].n).toBe(0);
  });

  it('a forged event cannot suppress the genuine event with the same id (no event-id poisoning)', async () => {
    const body = eventBody();
    const { id } = JSON.parse(body.toString()) as { id: string };
    await deliver(body, signWebhook(randomBytes(32), body, now())).expect(401);
    await deliver(body, signWebhook(randomBytes(32), body, now())).expect(401);
    await deliver(body, signWebhook(webhookSecret, body, now())).expect(202);
    await deliver(body, signWebhook(webhookSecret, body, now())).expect(202); // a genuine duplicate: deduped
    const rows = await eventRow(id);
    expect(rows.map((row) => row.signature_valid)).toEqual([false, false, true]);
  });

  it('a valid event for a payment we do not know is stored and parked as UNMATCHED — never dropped', async () => {
    for (const reference of [randomUUID(), 'not-a-uuid']) {
      const body = eventBody({ data: { object: { id: `pay_${randomBytes(6).toString('hex')}`, reference } } });
      const { id } = JSON.parse(body.toString()) as { id: string };
      await deliver(body, signWebhook(webhookSecret, body, now())).expect(202);
      await payments.processor.processDue(100);
      expect((await eventRow(id))[0]).toMatchObject({ outcome: 'UNMATCHED' });
      expect((await eventRow(id))[0].processed_at).not.toBeNull();
    }
  });

  it('a validly signed but unusable body is stored as MALFORMED and never processed', async () => {
    const body = Buffer.from('{"hello":"world"}');
    await deliver(body, signWebhook(webhookSecret, body, now())).expect(202);
    const [row] = (await harness.dataSource.query(
      `SELECT outcome, processed_at FROM webhook_events WHERE raw_payload = $1`,
      [body],
    )) as { outcome: string; processed_at: Date | null }[];
    expect(row.outcome).toBe('MALFORMED');
  });

  it('every other route keeps its JSON parsing and 100KB cap; the webhook route keeps the same cap on raw bytes', async () => {
    const big = Buffer.alloc(110 * 1024, 'a');
    const refused = await deliver(big, signWebhook(webhookSecret, big, now()));
    expect(refused.status).toBe(413);
    expect(refused.body.code).toBe('PAYLOAD_TOO_LARGE');
    // JSON routes still parse JSON (a validation error, not a Buffer surprise).
    const register = await http().post('/api/v1/auth/register').send({ email: 'not-an-email', password: 'x' });
    expect(register.status).toBe(400);
    expect(register.body.code).toBe('VALIDATION_FAILED');
  });

  it('provider_calls: a row per outbound call and per inbound delivery — with no secret, token, signature or card data', async () => {
    const { psp } = payments;
    const user = await payments.signUp();
    const response = await payments.fund(user, { amount: '150000', currency: 'NGN', paymentMethodToken: 'tok_success_leakcheck' });
    const flowId = (response.body as { fundingId: string }).fundingId;
    await payments.drive({ deliverWebhooks: false });
    const deliveries = psp.pendingWebhooks();
    await psp.deliverAll();
    const signatures = (
      (await harness.dataSource.query(`SELECT headers->>'x-psp-signature' AS signature FROM webhook_events WHERE provider_event_id = ANY($1)`, [
        deliveries.map((event) => event.id),
      ])) as { signature: string }[]
    ).map((row) => row.signature);
    expect(signatures).toHaveLength(deliveries.length);
    await payments.processor.processDue(100);

    const outbound = (await harness.dataSource.query(
      `SELECT operation, request_method, attempt, response_status FROM provider_calls WHERE flow_id = $1 AND direction = 'OUTBOUND' ORDER BY id`,
      [flowId],
    )) as { operation: string }[];
    expect(outbound.map((row) => row.operation)).toEqual(['find-payment-by-reference', 'authorize', 'get-payment', 'capture']);
    const inbound = (await harness.dataSource.query(
      `SELECT count(*)::int AS n FROM provider_calls WHERE direction = 'INBOUND' AND webhook_event_id IN
         (SELECT id FROM webhook_events WHERE provider_event_id = ANY($1))`,
      [deliveries.map((event) => event.id)],
    )) as { n: number }[];
    expect(inbound[0].n).toBe(deliveries.length);

    const everything = JSON.stringify(await harness.dataSource.query(`SELECT * FROM provider_calls`));
    for (const secret of [secretKey, webhookSecret.toString('base64'), webhookSecret.toString('hex'), 'tok_success_leakcheck', '"last4"', '"exp_year"', ...signatures]) {
      expect({ secret: secret.slice(0, 16), leaked: everything.includes(secret) }).toEqual({ secret: secret.slice(0, 16), leaked: false });
    }
    expect(everything).toContain('[REDACTED]');
  });
});
