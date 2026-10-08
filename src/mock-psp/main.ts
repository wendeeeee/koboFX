import 'dotenv/config';
import { MockPsp } from './mock-psp';

/**
 * Runs the simulated PSP for local development (`npm run start:mock-psp:dev`), with the
 * API's own PSP settings: webhooks are signed with the first `PSP_WEBHOOK_SECRETS` entry
 * and sent to `MOCK_PSP_WEBHOOK_URL`; captures complete after `MOCK_PSP_CAPTURE_DELAY_MS`.
 */
async function main(): Promise<void> {
  const secretKey = process.env.PSP_SECRET_KEY;
  const webhookSecret = process.env.PSP_WEBHOOK_SECRETS?.split(',')[0];
  if (!secretKey || !webhookSecret) throw new Error('PSP_SECRET_KEY and PSP_WEBHOOK_SECRETS are required');
  const webhookUrl = process.env.MOCK_PSP_WEBHOOK_URL ?? 'http://localhost:3000/api/v1/webhooks/psp';
  const port = Number(process.env.MOCK_PSP_PORT ?? '4010');
  const captureDelay = Number(process.env.MOCK_PSP_CAPTURE_DELAY_MS ?? '2000');

  const psp = new MockPsp({
    secretKey,
    webhookSecret: Buffer.from(webhookSecret, 'base64'),
    captureCompletion: { afterMilliseconds: captureDelay },
    autoDeliverWebhooks: true,
    deliverWebhook: async (body, headers) => (await fetch(webhookUrl, { method: 'POST', body, headers })).status,
  });
  const url = await psp.start(port, '0.0.0.0');
  process.stdout.write(`Simulated PSP listening on ${url}; webhooks → ${webhookUrl}\n`);
  const shutdown = () => void psp.stop().then(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
