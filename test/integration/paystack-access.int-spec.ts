import { buildOpenApiDocument } from '../../src/openapi/openapi-document';
import { signPaystackWebhook } from '../../src/modules/payments/paystack/webhooks/paystack-webhook-signature';
import { LedgerHarness, startLedgerHarness } from '../support/ledger-harness';
import request from 'supertest';

describe('Paystack source allowlist', () => {
  let harness: LedgerHarness;
  beforeAll(async () => {
    harness = await startLedgerHarness({}, { paystack: { webhookIpAllowlist: '192.0.2.1' } });
  });
  afterAll(async () => harness?.close());

  it('stores a valid signature from a refused source, returns 401, and never processes it', async () => {
    const paystack = harness.payments!.paystack!;
    const body = Buffer.from('{"event":"charge.success","data":{"id":99,"status":"success","reference":"blocked-source"}}');
    const response = await paystack.postWebhook(body, {
      'Content-Type': 'application/json', 'X-Paystack-Signature': signPaystackWebhook(paystack.secretKey, body),
      // With no trusted proxy, spoofing the allowed address cannot bypass req.ip.
      'X-Forwarded-For': '192.0.2.1',
    });
    expect(response.status).toBe(401);
    const [event] = await harness.dataSource.query("SELECT signature_valid, outcome, raw_payload FROM webhook_events WHERE provider = 'paystack'");
    expect(event.signature_valid).toBe(true);
    expect(event.raw_payload).toEqual(body);
    expect((await harness.payments!.processor.processDue(100)).claimed).toBe(0);
    expect(paystack.gatewayCalls).toHaveLength(0);
  });
});

describe('Paystack disabled', () => {
  let harness: LedgerHarness;
  beforeAll(async () => { harness = await startLedgerHarness({}, { payments: true }); });
  afterAll(async () => harness?.close());
  it('omits both routes from the router and its generated contract', async () => {
    const app = harness.auth!.app;
    const document = buildOpenApiDocument(app);
    const user = await harness.payments!.signUp();
    for (const path of ['/api/v1/wallet/fund/paystack', '/api/v1/webhooks/paystack']) {
      expect(document.paths[path]).toBeUndefined();
      await request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${user.accessToken}`).send({}).expect(404);
    }
  });
});
