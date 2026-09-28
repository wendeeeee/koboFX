import { createHmac, createPublicKey, randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import * as jsonwebtoken from 'jsonwebtoken';
import { authenticationTestEnvironment, encodePublicKeys, testKeyPair } from '../../../../test/support/authentication-secrets';
import { TestClock } from '../../../../test/support/auth-test-doubles';
import { UnauthenticatedError } from '../../../common/errors';
import { AppConfig, loadConfig } from '../../../config/configuration';
import { AccessTokenService } from './access-token.service';

const BASE_ENV = {
  NODE_ENV: 'test',
  DB_HOST: 'localhost',
  DB_NAME: 'kobofx',
  DB_APP_USER: 'fx_app',
  DB_APP_PASSWORD: 'a',
  DB_MIGRATION_USER: 'fx_owner',
  DB_MIGRATION_PASSWORD: 'b',
  REDIS_URL: 'redis://localhost:6379',
  ROUNDING_USER_CREDIT: 'ROUND_DOWN',
  ROUNDING_REVENUE: 'ROUND_HALF_EVEN',
  ROUNDING_FEE: 'ROUND_HALF_EVEN',
  ...authenticationTestEnvironment(),
};

const base64 = (text: string) => Buffer.from(text).toString('base64url');
const segment = (value: object) => base64(JSON.stringify(value));

describe('AccessTokenService (design §9.1: RS256, 15 minutes)', () => {
  const clock = new TestClock();
  const config: AppConfig = loadConfig(BASE_ENV);
  const service = new AccessTokenService(new JwtService({}), clock, config);
  const userId = randomUUID();
  const familyId = randomUUID();

  afterEach(() => clock.reset());

  it('round-trips identity: user id and session, expiring after 15 minutes', () => {
    const issued = service.issue(userId, familyId);
    const claims = service.verify(issued.token);
    expect(claims).toEqual({ userId, refreshTokenFamilyId: familyId, expiresAt: issued.expiresAt });
    expect(issued.expiresAt.getTime() - clock.now().getTime()).toBeLessThanOrEqual(900_000);
    expect(issued.expiresAt.getTime() - clock.now().getTime()).toBeGreaterThan(898_000);
  });

  it('signs RS256 with the configured key id, and carries no role or status claims', () => {
    const decoded = jsonwebtoken.decode(service.issue(userId, familyId).token, { complete: true })!;
    expect(decoded.header).toMatchObject({ alg: 'RS256', kid: 'test-key-1', typ: 'JWT' });
    expect(decoded.payload).toMatchObject({ sub: userId, familyId, tokenUse: 'access', iss: 'kobofx', aud: 'kobofx-api' });
    expect(decoded.payload).not.toHaveProperty('role');
    expect(decoded.payload).not.toHaveProperty('status');
  });

  it('refuses an expired token', () => {
    const { token } = service.issue(userId, familyId);
    clock.advance(15 * 60_000 + 1_000);
    expect(() => service.verify(token)).toThrow(UnauthenticatedError);
  });

  it('refuses a token signed by a key that is not in the verification set', () => {
    const stranger = testKeyPair('test-key-1-impostor');
    const token = jsonwebtoken.sign({ familyId, tokenUse: 'access' }, stranger.privateKeyPem, {
      algorithm: 'RS256',
      keyid: 'test-key-1',
      subject: userId,
      issuer: 'kobofx',
      audience: 'kobofx-api',
      expiresIn: 60,
    });
    expect(() => service.verify(token)).toThrow(UnauthenticatedError);
  });

  it('refuses an unknown key id', () => {
    const pair = testKeyPair();
    const token = jsonwebtoken.sign({ familyId, tokenUse: 'access' }, pair.privateKeyPem, {
      algorithm: 'RS256',
      keyid: 'retired-key',
      subject: userId,
      issuer: 'kobofx',
      audience: 'kobofx-api',
      expiresIn: 60,
    });
    expect(() => service.verify(token)).toThrow(UnauthenticatedError);
  });

  it('refuses a tampered payload (a different subject under the original signature)', () => {
    const [header, , signature] = service.issue(userId, familyId).token.split('.');
    const forged = segment({ sub: randomUUID(), familyId, tokenUse: 'access', iss: 'kobofx', aud: 'kobofx-api', exp: 9_999_999_999 });
    expect(() => service.verify(`${header}.${forged}.${signature}`)).toThrow(UnauthenticatedError);
  });

  it('refuses alg "none"', () => {
    const payload = segment({ sub: userId, familyId, tokenUse: 'access', iss: 'kobofx', aud: 'kobofx-api', exp: 9_999_999_999 });
    for (const alg of ['none', 'None', 'NONE']) {
      expect(() => service.verify(`${segment({ alg, kid: 'test-key-1', typ: 'JWT' })}.${payload}.`)).toThrow(
        UnauthenticatedError,
      );
    }
  });

  it('refuses an HS256 downgrade signed with the public key as the HMAC secret', () => {
    const publicPem = createPublicKey(testKeyPair().privateKey).export({ type: 'spki', format: 'pem' }).toString();
    const header = segment({ alg: 'HS256', kid: 'test-key-1', typ: 'JWT' });
    const payload = segment({ sub: userId, familyId, tokenUse: 'access', iss: 'kobofx', aud: 'kobofx-api', exp: 9_999_999_999 });
    const signature = createHmac('sha256', publicPem).update(`${header}.${payload}`).digest('base64url');
    expect(() => service.verify(`${header}.${payload}.${signature}`)).toThrow(UnauthenticatedError);
  });

  it('refuses the wrong issuer, the wrong audience, another token use, or a malformed subject', () => {
    const pair = testKeyPair();
    const sign = (payload: object, options: jsonwebtoken.SignOptions) =>
      jsonwebtoken.sign(payload, pair.privateKeyPem, { algorithm: 'RS256', keyid: 'test-key-1', expiresIn: 60, ...options });
    const good = { subject: userId, issuer: 'kobofx', audience: 'kobofx-api' };
    expect(() => service.verify(sign({ familyId, tokenUse: 'access' }, { ...good, issuer: 'evil' }))).toThrow(UnauthenticatedError);
    expect(() => service.verify(sign({ familyId, tokenUse: 'access' }, { ...good, audience: 'other' }))).toThrow(UnauthenticatedError);
    expect(() => service.verify(sign({ familyId, tokenUse: 'refresh' }, good))).toThrow(UnauthenticatedError);
    expect(() => service.verify(sign({ familyId: 'x', tokenUse: 'access' }, good))).toThrow(UnauthenticatedError);
    expect(() => service.verify(sign({ familyId, tokenUse: 'access' }, { ...good, subject: 'admin' }))).toThrow(UnauthenticatedError);
    expect(() => service.verify(sign({ familyId, tokenUse: 'access' }, good))).not.toThrow();
  });

  it('refuses garbage', () => {
    for (const garbage of ['', 'abc', 'a.b.c', '...', 'eyJ.eyJ.sig']) {
      expect(() => service.verify(garbage)).toThrow(UnauthenticatedError);
    }
  });

  it('rotation: tokens from the previous key verify while it is still published', () => {
    const previous = testKeyPair('test-key-0');
    const current = testKeyPair('test-key-2');
    const rotated = loadConfig({
      ...BASE_ENV,
      JWT_SIGNING_KEY_ID: current.keyId,
      JWT_PRIVATE_KEY: Buffer.from(current.privateKeyPem).toString('base64'),
      JWT_PUBLIC_KEYS: encodePublicKeys([previous, current]),
    });
    const oldService = new AccessTokenService(
      new JwtService({}),
      clock,
      loadConfig({
        ...BASE_ENV,
        JWT_SIGNING_KEY_ID: previous.keyId,
        JWT_PRIVATE_KEY: Buffer.from(previous.privateKeyPem).toString('base64'),
        JWT_PUBLIC_KEYS: encodePublicKeys([previous]),
      }),
    );
    const newService = new AccessTokenService(new JwtService({}), clock, rotated);
    expect(newService.verify(oldService.issue(userId, familyId).token).userId).toBe(userId);
    expect(jsonwebtoken.decode(newService.issue(userId, familyId).token, { complete: true })!.header.kid).toBe('test-key-2');
  });
});
