import 'dotenv/config';
import { parseMockPaystackSeed } from './dev-seed';
import { MockPaystack } from './mock-paystack';

/**
 * Runs the simulated Paystack for local development (`npm run start:mock-paystack:dev`). Point the API at it with
 * `PAYSTACK_BASE_URL=http://localhost:4030`. It accepts the API's own `PAYSTACK_SECRET_KEY` (a test key — the key is
 * only compared, never printed), signs webhooks with it and sends them to `MOCK_PAYSTACK_WEBHOOK_URL`. Its checkout
 * page (`/checkout/{accessCode}`) has "Pay" and "Decline" buttons and then returns the browser to the callback URL.
 * For withdrawals it starts with bank accounts to resolve, a balance and a transfer outcome (`dev-seed.ts`:
 * `MOCK_PAYSTACK_ACCOUNTS`, `MOCK_PAYSTACK_BALANCE`, `MOCK_PAYSTACK_TRANSFER_STATUS`, `MOCK_PAYSTACK_TRANSFER_FEE`).
 */
async function main(): Promise<void> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is required (the mock accepts only the key the API sends)');
  if (secretKey.startsWith('sk_live_')) throw new Error('Refusing to run the mock with a live key');
  const webhookUrl = process.env.MOCK_PAYSTACK_WEBHOOK_URL ?? 'http://localhost:3000/api/v1/webhooks/paystack';
  const port = Number(process.env.MOCK_PAYSTACK_PORT ?? '4030');
  const seed = parseMockPaystackSeed(process.env);

  const paystack = new MockPaystack({
    secretKey,
    autoDeliverWebhooks: true,
    deliverWebhook: async (body, headers) => (await fetch(webhookUrl, { method: 'POST', body, headers })).status,
  });
  for (const account of seed.accounts) paystack.transfers.addAccount(account.bankCode, account.accountNumber, account.accountName);
  paystack.transfers.setBalance(seed.balanceMinor);
  paystack.transfers.setNextTransfer({ status: seed.transferStatus, fee: seed.transferFeeMinor, domain: 'test' });
  const url = await paystack.start(port, '0.0.0.0');
  process.stdout.write(`Simulated Paystack listening on ${url}; webhooks → ${webhookUrl}\n`);
  process.stdout.write(
    `Withdrawals: ${seed.accounts.length} bank account(s) resolve: ` +
      `${seed.accounts.map((account) => `${account.bankCode}/${account.accountNumber} (${account.accountName})`).join(', ')}; ` +
      `balance ${seed.balanceMinor} kobo; new transfers are '${seed.transferStatus}', fee ${seed.transferFeeMinor} kobo\n`,
  );
  const shutdown = () => void paystack.stop().then(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
