import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DependencyUnavailableError } from '../../src/common/errors';
import { AccountCreationService } from '../../src/modules/auth/account-creation.service';
import { VerificationService } from '../../src/modules/auth/verification.service';
import { AuthHarness, LedgerHarness, startLedgerHarness } from '../support/ledger-harness';

const PASSWORD = 'a perfectly long password';

/**
 * Redis stopped mid-test (design §7.1, §16; decision #10). Verification fails CLOSED —
 * a 503, never a bypass. Credential and email routes fail closed; routes behind an
 * unguessable credential fail open. Its own file: the container does not come back.
 */
describe('Redis down', () => {
  let harness: LedgerHarness;
  let auth: AuthHarness;
  const pending = { email: `pending-${randomUUID().slice(0, 8)}@example.com`, code: '' };
  let active: { email: string; accessToken: string; refreshToken: string };

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { auth: true });
    auth = harness.auth!;
    const accountCreation = harness.moduleRef.get(AccountCreationService);
    const verification = harness.moduleRef.get(VerificationService);

    await accountCreation.register(pending.email, PASSWORD);
    const activeEmail = `active-${randomUUID().slice(0, 8)}@example.com`;
    await accountCreation.register(activeEmail, PASSWORD);
    await auth.deliverOutbox();
    pending.code = auth.emails.latestCodeFor(pending.email);
    const session = await verification.verifyEmail(activeEmail, PASSWORD, auth.emails.latestCodeFor(activeEmail));
    active = { email: activeEmail, accessToken: session.tokens.access.token, refreshToken: session.tokens.refresh.token };

    await auth.redis.stop();
  });

  afterAll(() => harness?.close());

  const http = () => request(auth.app.getHttpServer());

  it('verify with the CORRECT code is a 503, and the user stays unverified — never a bypass', async () => {
    const response = await http()
      .post('/api/v1/auth/verify')
      .send({ email: pending.email, password: PASSWORD, oneTimePassword: pending.code });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(response.header['retry-after']).toBe('5');
    await expect(
      harness.moduleRef.get(VerificationService).verifyEmail(pending.email, PASSWORD, pending.code),
    ).rejects.toThrow(DependencyUnavailableError);
    const [row] = (await harness.dataSource.query(`SELECT status, verified_at FROM users WHERE email = $1`, [pending.email])) as {
      status: string;
      verified_at: Date | null;
    }[];
    expect(row).toEqual({ status: 'PENDING_VERIFICATION', verified_at: null });
  });

  it('login, register and resend fail closed (503)', async () => {
    for (const [path, body] of [
      ['login', { email: active.email, password: PASSWORD }],
      ['register', { email: `new-${randomUUID().slice(0, 8)}@example.com`, password: PASSWORD }],
      ['resend-otp', { email: pending.email }],
    ] as const) {
      const response = await http().post(`/api/v1/auth/${path}`).send(body);
      expect({ path, status: response.status, code: response.body.code }).toEqual({
        path,
        status: 503,
        code: 'DEPENDENCY_UNAVAILABLE',
      });
    }
  });

  it('existing sessions keep working: authenticated routes and refresh fail open', async () => {
    await http().get('/api/v1/users/me').set('Authorization', `Bearer ${active.accessToken}`).expect(200);
    const refreshed = await http().post('/api/v1/auth/refresh').send({ refreshToken: active.refreshToken }).expect(200);
    expect(refreshed.body.tokens.refresh.token).not.toBe(active.refreshToken);
  });

  it('readiness reports Redis down', async () => {
    const response = await http().get('/api/v1/health/ready').expect(503);
    // Since Phase 6 readiness also REPORTS rate freshness (never failing on it); no snapshot here.
    expect(response.body).toEqual({
      status: 'unavailable',
      checks: { postgres: 'up', redis: 'down' },
      fx: { tier: 'NONE', rateAgeSeconds: null, provider: null, asOf: null },
    });
    await http().get('/api/v1/health/live').expect(200);
  });
});
