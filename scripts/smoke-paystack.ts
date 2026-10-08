import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { ProviderCallRecorder } from '../src/common/http/provider-call-recorder';
import { Money } from '../src/common/money';
import { loadConfig } from '../src/config/configuration';
import { PaystackAdapter } from '../src/modules/payments/paystack/paystack.adapter';
import { PaystackHttpClient } from '../src/modules/payments/paystack/paystack-http-client';

/** Manual only. The user id selects a stored email; credentials are read only by loadConfig. */
async function main(): Promise<void> {
  if (process.env.CI || process.env.NODE_ENV === 'test') throw new Error('Manual smoke only');
  const config = loadConfig(process.env);
  const settings = config.paystack;
  if (!settings.enabled || !settings.secretKey.startsWith('sk_test_')) throw new Error('Test mode must be enabled');
  if (settings.baseUrl.replace(/\/+$/, '') !== 'https://api.paystack.co') throw new Error('Use the official Paystack API');
  const userId = process.argv[2];
  if (!userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    process.stderr.write('Usage: npm run paystack:smoke -- <active-user-uuid>\n');
    process.exitCode = 1;
    return;
  }
  const database = new Client({
    host: config.db.host, port: config.db.port, database: config.db.name,
    user: config.db.app.user, password: config.db.app.password,
  });
  let email: string;
  await database.connect();
  try {
    const result = await database.query<{ email: string }>('SELECT email FROM users WHERE id = $1 AND status = $2', [userId, 'ACTIVE']);
    if (!result.rows[0]) throw new Error('An active user is required');
    email = result.rows[0].email;
  } finally {
    await database.end();
  }
  // This diagnostic creates no funding flow and stores no provider response. Print statuses only.
  const recorder = { recordQuietly: async () => undefined } as unknown as ProviderCallRecorder;
  const adapter = new PaystackAdapter(settings.name, new PaystackHttpClient({
    provider: settings.name, baseUrl: settings.baseUrl, secretKey: settings.secretKey,
    timeoutMilliseconds: settings.requestTimeoutMilliseconds,
    initializeTimeoutMilliseconds: settings.initializeTimeoutMilliseconds, readRetries: settings.readRetries,
  }, recorder));
  const reference = `smoke-${randomUUID()}`;
  const now = new Date();
  await adapter.initialize({ reference, email, amount: Money.of(150000n, 'NGN'), callbackUrl: settings.callbackUrl, metadata: { diagnostic: 'manual-smoke' } }, {});
  process.stdout.write('initialize: accepted\n');
  const transaction = await adapter.verify(reference, {});
  process.stdout.write(`verify: ${transaction?.status ?? 'not_found'}\n`);
  const missing = await adapter.verify(`smoke-missing-${randomUUID()}`, {});
  if (missing !== null) throw new Error('Unexpected verify result');
  process.stdout.write('unknown reference: not_found\n');
  await adapter.listTransactions({ from: new Date(now.getTime() - 86400000), to: new Date(now.getTime() + 86400000) });
  process.stdout.write('list: parsed successfully\n');
}

main().catch(() => {
  // Never echo provider/config/database errors: they may contain credentials or customer identity.
  process.stderr.write('Paystack smoke failed. Check test-mode configuration, active user id and connectivity; see docs/TESTING.md.\n');
  process.exitCode = 1;
});
