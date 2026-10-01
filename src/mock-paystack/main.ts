import 'dotenv/config';
import { MockPaystack } from './mock-paystack';

/**
 * Runs the simulated Paystack for local development (`npm run start:mock-paystack:dev`). Point the API at it with
 * `PAYSTACK_BASE_URL=http://localhost:4030`. It accepts the API's own `PAYSTACK_SECRET_KEY` (a test key — the key is
 * only compared, never printed), signs webhooks with it and sends them to `MOCK_PAYSTACK_WEBHOOK_URL`. Its checkout
 * page (`/checkout/{accessCode}`) has "Pay" and "Decline" buttons and then returns the browser to the callback URL.
 */
async function main(): Promise<void> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is required (the mock accepts only the key the API sends)');
  if (secretKey.startsWith('sk_live_')) throw new Error('Refusing to run the mock with a live key');
  const webhookUrl = process.env.MOCK_PAYSTACK_WEBHOOK_URL ?? 'http://localhost:3000/api/v1/webhooks/paystack';
  const port = Number(process.env.MOCK_PAYSTACK_PORT ?? '4030');

  const paystack = new MockPaystack({
    secretKey,
    autoDeliverWebhooks: true,
    deliverWebhook: async (body, headers) => (await fetch(webhookUrl, { method: 'POST', body, headers })).status,
  });
  const url = await paystack.start(port, '0.0.0.0');
  process.stdout.write(`Simulated Paystack listening on ${url}; webhooks → ${webhookUrl}\n`);
  const shutdown = () => void paystack.stop().then(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
