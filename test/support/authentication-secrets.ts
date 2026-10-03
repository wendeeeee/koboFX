import { KeyObject, generateKeyPairSync, randomBytes } from 'node:crypto';

export interface TestKeyPair {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
}

const keyPairs = new Map<string, TestKeyPair>();

export function testKeyPair(keyId = 'test-key-1'): TestKeyPair {
  let pair = keyPairs.get(keyId);
  if (!pair) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    pair = {
      keyId,
      privateKey,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
    keyPairs.set(keyId, pair);
  }
  return pair;
}

const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

export function encodePublicKeys(pairs: readonly TestKeyPair[]): string {
  return base64(JSON.stringify(Object.fromEntries(pairs.map((pair) => [pair.keyId, pair.publicKeyPem]))));
}

const pepper = randomBytes(32).toString('base64');
const pspSecretKey = `sk_test_${randomBytes(24).toString('hex')}`;
const pspWebhookSecret = randomBytes(32).toString('base64');

export function paymentProviderTestSecrets(): { secretKey: string; webhookSecret: Buffer } {
  return { secretKey: pspSecretKey, webhookSecret: Buffer.from(pspWebhookSecret, 'base64') };
}


export function authenticationTestEnvironment(): Record<string, string> {
  const pair = testKeyPair();
  return {
    JWT_SIGNING_KEY_ID: pair.keyId,
    JWT_PRIVATE_KEY: base64(pair.privateKeyPem),
    JWT_PUBLIC_KEYS: encodePublicKeys([pair]),
    ONE_TIME_PASSWORD_PEPPER: pepper,
    SMTP_HOST: 'localhost',
    SMTP_PORT: '1025',
    MAIL_FROM: 'KoboFX <no-reply@kobofx.test>',
    PSP_BASE_URL: 'http://127.0.0.1:9',
    PSP_SECRET_KEY: pspSecretKey,
    PSP_WEBHOOK_SECRETS: pspWebhookSecret,
    FX_RATE_BASE_URL: 'http://127.0.0.1:9/v6/latest',
  };
}
