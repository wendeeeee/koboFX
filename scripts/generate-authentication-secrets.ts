/**
 * Prints fresh authentication secrets as .env lines (design §9.1, decision #11):
 * an RS256 key pair with a key id, and the one-time password pepper — plus the
 * simulated PSP's API key and webhook secret (design §7.2, §7.3), shared by the API,
 * the worker and `npm run start:mock-psp:dev`.
 *
 *   npm run --silent secrets:generate >> .env
 *
 * Dev only. Production secrets come from the secret manager, never from this script,
 * and are never committed.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const keyId = `key-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

process.stdout.write(
  [
    `JWT_SIGNING_KEY_ID=${keyId}`,
    `JWT_PRIVATE_KEY=${base64(privatePem)}`,
    `JWT_PUBLIC_KEYS=${base64(JSON.stringify({ [keyId]: publicPem }))}`,
    `ONE_TIME_PASSWORD_PEPPER=${randomBytes(32).toString('base64')}`,
    `PSP_SECRET_KEY=sk_dev_${randomBytes(24).toString('hex')}`,
    `PSP_WEBHOOK_SECRETS=${randomBytes(32).toString('base64')}`,
    '',
  ].join('\n'),
);
