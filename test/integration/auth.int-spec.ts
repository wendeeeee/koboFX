import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import type Redis from 'ioredis';
import * as jsonwebtoken from 'jsonwebtoken';
import { Client } from 'pg';
import request from 'supertest';
import { UnitOfWork } from '../../src/database/transaction/unit-of-work';
import { AccountCreationService } from '../../src/modules/auth/account-creation.service';
import { VerificationFailedError } from '../../src/modules/auth/auth.errors';
import { LoginService } from '../../src/modules/auth/login.service';
import { GenerateAndDispatchOneTimePasswordService } from '../../src/modules/auth/one-time-passwords/generate-and-dispatch-one-time-password.service';
import {
  OneTimePasswordPurpose,
  hashOneTimePassword,
} from '../../src/modules/auth/one-time-passwords/one-time-password';
import { OneTimePasswordChallengeStore } from '../../src/modules/auth/one-time-passwords/one-time-password-challenge.store';
import { VerificationService } from '../../src/modules/auth/verification.service';
import { UnauthenticatedError } from '../../src/common/errors';
import { ChartOfAccountsService } from '../../src/modules/ledger/chart-of-accounts.service';
import { InvalidPostingError } from '../../src/modules/ledger/ledger.errors';
import { WalletProvisioningService } from '../../src/modules/wallets/wallet-provisioning.service';
import { UserRepository } from '../../src/modules/users/user.repository';
import { RedisService } from '../../src/redis/redis.service';
import { AuthHarness, LedgerHarness, startLedgerHarness } from '../support/ledger-harness';

const DEMO_CREDIT_MINOR = 10_000_000n; // ₦100,000.00
const PASSWORD = 'a perfectly long password';

describe('authentication (integration: real Postgres + Redis)', () => {
  let harness: LedgerHarness;
  let auth: AuthHarness;
  let redis: Redis;
  let accountCreation: AccountCreationService;
  let verification: VerificationService;
  let login: LoginService;
  let owner: Client;
  let superuser: Client;
  let appRole: Client;

  beforeAll(async () => {
    harness = await startLedgerHarness(
      { DEMO_CREDIT_NGN_MINOR: DEMO_CREDIT_MINOR.toString(), OUTBOX_MAX_ATTEMPTS: '3' },
      { auth: true },
    );
    auth = harness.auth!;
    redis = harness.moduleRef.get(RedisService).client;
    accountCreation = harness.moduleRef.get(AccountCreationService);
    verification = harness.moduleRef.get(VerificationService);
    login = harness.moduleRef.get(LoginService);
    owner = await harness.db.ownerClient();
    superuser = await harness.db.superuserClient();
    appRole = await harness.db.appClient();
  });

  afterAll(async () => {
    await owner?.end();
    await superuser?.end();
    await appRole?.end();
    await harness?.close();
  });

  afterEach(() => auth.clock.reset());

  const newEmail = () => `user-${randomUUID().slice(0, 8)}@example.com`;
  const userIdOf = async (email: string) =>
    ((await harness.dataSource.query(`SELECT id FROM users WHERE email = $1`, [email])) as { id: string }[])[0]?.id;
  const statusOf = async (email: string) =>
    ((await harness.dataSource.query(`SELECT status FROM users WHERE email = $1`, [email])) as { status: string }[])[0]
      ?.status;

  /** Register and have the worker send the code. */
  async function registerWithCode(email = newEmail(), password = PASSWORD): Promise<{ email: string; code: string }> {
    await accountCreation.register(email, password);
    await auth.deliverOutbox();
    return { email, code: auth.emails.latestCodeFor(email) };
  }

  async function activeUser(): Promise<{ email: string; userId: string; refreshToken: string; accessToken: string }> {
    const { email, code } = await registerWithCode();
    const session = await verification.verifyEmail(email, PASSWORD, code);
    return {
      email,
      userId: session.user.id,
      refreshToken: session.tokens.refresh.token,
      accessToken: session.tokens.access.token,
    };
  }

  describe('schema guards', () => {
    it('audit_logs is append-only: fx_app lacks the grants, and the trigger stops even the owner and a superuser', async () => {
      await activeUser();
      const [row] = (await owner.query(`SELECT id FROM audit_logs LIMIT 1`)).rows as { id: string }[];
      await expect(appRole.query(`UPDATE audit_logs SET reason = 'x' WHERE id = $1`, [row.id])).rejects.toThrow(/permission denied/);
      await expect(appRole.query(`DELETE FROM audit_logs WHERE id = $1`, [row.id])).rejects.toThrow(/permission denied/);
      await expect(appRole.query(`TRUNCATE audit_logs`)).rejects.toThrow(/permission denied/);
      for (const client of [owner, superuser]) {
        await expect(client.query(`UPDATE audit_logs SET reason = 'x' WHERE id = $1`, [row.id])).rejects.toThrow(
          'audit_logs is append-only (attempted UPDATE)',
        );
        await expect(client.query(`DELETE FROM audit_logs WHERE id = $1`, [row.id])).rejects.toThrow(
          'audit_logs is append-only (attempted DELETE)',
        );
        await expect(client.query(`TRUNCATE audit_logs`)).rejects.toThrow('audit_logs is append-only (attempted TRUNCATE)');
      }
    });

    it('audit_logs holds no password, one-time password, token or email material', async () => {
      const { email, code } = await registerWithCode();
      const session = await verification.verifyEmail(email, PASSWORD, code);
      const reused = session.tokens.refresh.token;
      await login.refresh(reused);
      await expect(login.refresh(reused)).rejects.toThrow(UnauthenticatedError); // reuse → revocation audit row
      const dump = JSON.stringify((await owner.query(`SELECT * FROM audit_logs`)).rows);
      for (const secret of [PASSWORD, code, session.tokens.access.token, reused, email, '@example.com', '$argon2']) {
        expect(dump).not.toContain(secret);
      }
      const actions = (await owner.query(`SELECT DISTINCT action FROM audit_logs ORDER BY action`)).rows.map(
        (row: { action: string }) => row.action,
      );
      expect(actions).toEqual(expect.arrayContaining(['REFRESH_TOKEN_FAMILY_REVOKED', 'USER_REGISTERED', 'USER_VERIFIED']));
    });

    it('users: email and id are immutable, status never returns to pending, rows are never deleted, fx_app cannot grant roles', async () => {
      const { userId, email } = await activeUser();
      await expect(owner.query(`UPDATE users SET email = 'other@example.com' WHERE id = $1`, [userId])).rejects.toThrow(
        /immutable id, email and created_at/,
      );
      await expect(owner.query(`UPDATE users SET status = 'PENDING_VERIFICATION' WHERE id = $1`, [userId])).rejects.toThrow(
        /cannot return to PENDING_VERIFICATION/,
      );
      await expect(owner.query(`UPDATE users SET verified_at = now() - interval '1 day' WHERE id = $1`, [userId])).rejects.toThrow(
        /already recorded its verification/,
      );
      await expect(owner.query(`DELETE FROM users WHERE id = $1`, [userId])).rejects.toThrow(/never deleted/);
      await expect(appRole.query(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [userId])).rejects.toThrow(/permission denied/);
      await expect(appRole.query(`DELETE FROM users WHERE id = $1`, [userId])).rejects.toThrow(/permission denied/);
      await expect(owner.query(`INSERT INTO users (email, password_hash) VALUES ($1, '$argon2id$x')`, [email.toUpperCase()])).rejects.toThrow(
        /users_email_normalized/,
      );
      await expect(owner.query(`INSERT INTO users (email, password_hash) VALUES ('x@example.com', 'plaintext')`)).rejects.toThrow(
        /users_password_hash_argon2id/,
      );
    });

    it('refresh tokens and challenges keep their set-once columns, and are never deleted', async () => {
      const { userId } = await activeUser();
      const [token] = (await owner.query(`SELECT refresh_tokens.id FROM refresh_tokens JOIN refresh_token_families f ON f.id = family_id WHERE f.user_id = $1`, [userId])).rows as { id: string }[];
      await expect(owner.query(`UPDATE refresh_tokens SET expires_at = expires_at + interval '1 year' WHERE id = $1`, [token.id])).rejects.toThrow(/immutable apart from used_at/);
      await expect(owner.query(`DELETE FROM refresh_tokens WHERE id = $1`, [token.id])).rejects.toThrow(/never deleted/);
      await expect(appRole.query(`UPDATE refresh_tokens SET expires_at = now() WHERE id = $1`, [token.id])).rejects.toThrow(/permission denied/);
      const [challenge] = (await owner.query(`SELECT id FROM one_time_password_challenges WHERE user_id = $1`, [userId])).rows as { id: string }[];
      await expect(owner.query(`UPDATE one_time_password_challenges SET outcome = 'EXHAUSTED' WHERE id = $1`, [challenge.id])).rejects.toThrow(/already been resolved/);
      const columns = (await owner.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'one_time_password_challenges'`)).rows.map((row: { column_name: string }) => row.column_name);
      expect(columns.join()).not.toMatch(/code|hmac|hash/);
    });
  });

  describe('POST /auth/register', () => {
    it('creates the user (pending), wallet, NGN account, outbox event and audit row in one transaction; no code in any row', async () => {
      const email = newEmail();
      const before = await harness.snapshot();
      await expect(accountCreation.register(email, PASSWORD)).resolves.toBe('CREATED');
      const after = await harness.snapshot();
      expect(after.userCount - before.userCount).toBe(1);
      expect(after.walletCount - before.walletCount).toBe(1);
      expect(after.outboxEventCount - before.outboxEventCount).toBe(1);
      expect(after.auditLogCount - before.auditLogCount).toBe(1);
      const userId = await userIdOf(email);
      const [account] = (await harness.dataSource.query(
        `SELECT accounts.code, accounts.account_type, accounts.normal_side, accounts.balance_minor::text AS balance
           FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id WHERE wallets.user_id = $1`,
        [userId],
      )) as { code: string; account_type: string; normal_side: string; balance: string }[];
      expect(account).toMatchObject({ account_type: 'LIABILITY', normal_side: 'CREDIT', balance: '0' });
      expect(account.code).toMatch(/^USER:[0-9a-f-]{36}:NGN$/);
      expect(await statusOf(email)).toBe('PENDING_VERIFICATION');
      const [event] = (await harness.dataSource.query(`SELECT event_type, payload FROM outbox_events WHERE aggregate_id = $1`, [userId])) as {
        event_type: string;
        payload: unknown;
      }[];
      expect(event).toEqual({ event_type: 'EmailVerificationRequested.v1', payload: { userId } });
      expect(transactionsTouch(await harness.snapshot(), before)).toBe(false);
      await harness.expectCleanBooks();
    });

    it('a failure after the user insert leaves nothing behind', async () => {
      const chartOfAccounts = harness.moduleRef.get(ChartOfAccountsService);
      const failure = jest.spyOn(chartOfAccounts, 'openUserAccount').mockRejectedValueOnce(new Error('injected'));
      const email = newEmail();
      const before = await harness.snapshot();
      await expect(accountCreation.register(email, PASSWORD)).rejects.toThrow('injected');
      expect(await harness.snapshot()).toEqual(before);
      expect(await userIdOf(email)).toBeUndefined();
      failure.mockRestore();
      await harness.expectCleanBooks();
    });

    it('an email pending verification: the new password replaces the old, and a fresh code is requested', async () => {
      const { email, code: firstCode } = await registerWithCode();
      await expect(accountCreation.register(email, 'the second, real password')).resolves.toBe('PENDING_RENEWED');
      await auth.deliverOutbox();
      const secondCode = auth.emails.latestCodeFor(email);
      // The first code was superseded; the first password no longer activates the account.
      await expect(verification.verifyEmail(email, PASSWORD, firstCode)).rejects.toThrow(VerificationFailedError);
      await expect(verification.verifyEmail(email, PASSWORD, secondCode)).rejects.toThrow(VerificationFailedError);
      await accountCreation.register(email, 'the second, real password');
      await auth.deliverOutbox();
      const session = await verification.verifyEmail(email, 'the second, real password', auth.emails.latestCodeFor(email));
      expect(session.user.status).toBe('ACTIVE');
      const outcomes = (await harness.dataSource.query(
        `SELECT outcome FROM one_time_password_challenges WHERE user_id = $1 ORDER BY issued_at`,
        [session.user.id],
      )) as { outcome: string }[];
      expect(outcomes.map((row) => row.outcome)).toEqual(['SUPERSEDED', 'SUPERSEDED', 'CONSUMED']);
    });

    it('an active email: nothing about the account changes, and the owner gets one notice per hour', async () => {
      const { email, userId } = await activeUser();
      const [before] = (await harness.dataSource.query(`SELECT password_hash, status FROM users WHERE id = $1`, [userId])) as object[];
      await expect(accountCreation.register(email, 'an attacker password')).resolves.toBe('ALREADY_REGISTERED');
      await expect(accountCreation.register(email, 'an attacker password')).resolves.toBe('ALREADY_REGISTERED');
      await auth.deliverOutbox();
      expect(await harness.dataSource.query(`SELECT password_hash, status FROM users WHERE id = $1`, [userId])).toEqual([before]);
      const notices = auth.emails.sentTo(email).filter((message) => message.subject.includes('already have'));
      expect(notices).toHaveLength(1);
      await expect(login.login(email, 'an attacker password')).rejects.toThrow('incorrect');
    });
  });

  describe('one-time password lifecycle (design §7.1)', () => {
    it('verify: ACTIVE, verified_at, challenge CONSUMED, one USER_VERIFIED audit row, tokens returned', async () => {
      const { email, code } = await registerWithCode();
      const session = await verification.verifyEmail(email, PASSWORD, code);
      expect(session.user).toMatchObject({ email, status: 'ACTIVE', role: 'USER' });
      expect(session.user.verifiedAt).not.toBeNull();
      expect(session.tokens.tokenType).toBe('Bearer');
      const [challenge] = (await harness.dataSource.query(
        `SELECT outcome FROM one_time_password_challenges WHERE user_id = $1`,
        [session.user.id],
      )) as { outcome: string }[];
      expect(challenge.outcome).toBe('CONSUMED');
      const audits = (await harness.dataSource.query(
        `SELECT actor_type, actor_id, before, after FROM audit_logs WHERE subject_id = $1 AND action = 'USER_VERIFIED'`,
        [session.user.id],
      )) as unknown[];
      expect(audits).toEqual([
        {
          actor_type: 'USER',
          actor_id: session.user.id,
          before: { status: 'PENDING_VERIFICATION', verified: false },
          after: { status: 'ACTIVE', verified: true },
        },
      ]);
      expect(await redis.exists(OneTimePasswordChallengeStore.key(OneTimePasswordPurpose.VERIFY_EMAIL, session.user.id))).toBe(0);
    });

    it('Redis holds only the HMAC and an attempt counter, with a 10-minute TTL', async () => {
      const { email, code } = await registerWithCode();
      const key = OneTimePasswordChallengeStore.key(OneTimePasswordPurpose.VERIFY_EMAIL, await userIdOf(email));
      const stored = await redis.hgetall(key);
      expect(Object.keys(stored).sort()).toEqual(['attempts', 'challengeId', 'hmac']);
      expect(JSON.stringify(stored)).not.toContain(code);
      const pepper = harness.moduleRef.get(VerificationService)['pepper'] as Buffer;
      expect(stored.hmac).toBe(hashOneTimePassword(pepper, stored.challengeId, code).toString('hex'));
      const ttl = await redis.pttl(key);
      expect(ttl).toBeGreaterThan(595_000);
      expect(ttl).toBeLessThanOrEqual(600_000);
    });

    it('expires with its TTL: after expiry the correct code is refused', async () => {
      const { email, code } = await registerWithCode();
      const key = OneTimePasswordChallengeStore.key(OneTimePasswordPurpose.VERIFY_EMAIL, await userIdOf(email));
      await redis.pexpire(key, 1); // the TTL elapsing, without waiting 10 minutes
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(verification.verifyEmail(email, PASSWORD, code)).rejects.toThrow(VerificationFailedError);
      expect(await statusOf(email)).toBe('PENDING_VERIFICATION');
    });

    it('is destroyed after 5 wrong attempts; the correct code is refused afterwards; the challenge is EXHAUSTED', async () => {
      const { email, code } = await registerWithCode();
      const wrong = code === '000000' ? '000001' : '000000';
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await expect(verification.verifyEmail(email, PASSWORD, wrong)).rejects.toThrow(VerificationFailedError);
      }
      expect(await redis.exists(OneTimePasswordChallengeStore.key(OneTimePasswordPurpose.VERIFY_EMAIL, await userIdOf(email)))).toBe(0);
      await expect(verification.verifyEmail(email, PASSWORD, code)).rejects.toThrow(VerificationFailedError);
      const [challenge] = (await harness.dataSource.query(
        `SELECT outcome FROM one_time_password_challenges WHERE user_id = $1`,
        [await userIdOf(email)],
      )) as { outcome: string }[];
      expect(challenge.outcome).toBe('EXHAUSTED');
    });

    it('the 5th attempt still counts if it is correct', async () => {
      const { email, code } = await registerWithCode();
      const wrong = code === '000000' ? '000001' : '000000';
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await expect(verification.verifyEmail(email, PASSWORD, wrong)).rejects.toThrow(VerificationFailedError);
      }
      await expect(verification.verifyEmail(email, PASSWORD, code)).resolves.toMatchObject({ user: { status: 'ACTIVE' } });
    });

    it('is single-use', async () => {
      const { email, code } = await registerWithCode();
      await verification.verifyEmail(email, PASSWORD, code);
      await expect(verification.verifyEmail(email, PASSWORD, code)).rejects.toThrow(VerificationFailedError);
    });

    it('needs the password too; a wrong password burns an attempt (verify is no password oracle)', async () => {
      const { email, code } = await registerWithCode();
      await expect(verification.verifyEmail(email, 'not the password at all', code)).rejects.toThrow(VerificationFailedError);
      const stored = await redis.hgetall(OneTimePasswordChallengeStore.key(OneTimePasswordPurpose.VERIFY_EMAIL, await userIdOf(email)));
      expect(stored.attempts).toBe('1');
      await expect(verification.verifyEmail(email, PASSWORD, code)).resolves.toMatchObject({ user: { status: 'ACTIVE' } });
    });

    it('an unknown email fails exactly like a wrong code', async () => {
      await expect(verification.verifyEmail(newEmail(), PASSWORD, '123456')).rejects.toThrow(VerificationFailedError);
    });

    it('a redelivered event issues a fresh challenge that supersedes the first: only the newest code works', async () => {
      const email = newEmail();
      await accountCreation.register(email, PASSWORD);
      const userId = await userIdOf(email);
      const [event] = (await harness.dataSource.query(`SELECT id FROM outbox_events WHERE aggregate_id = $1`, [userId])) as { id: string }[];
      const dispatcher = harness.moduleRef.get(GenerateAndDispatchOneTimePasswordService);
      await dispatcher.dispatchEmailVerification(userId, event.id);
      const first = auth.emails.latestCodeFor(email);
      await dispatcher.dispatchEmailVerification(userId, event.id); // the at-least-once duplicate
      const second = auth.emails.latestCodeFor(email);
      const outcomes = (await harness.dataSource.query(
        `SELECT outcome FROM one_time_password_challenges WHERE user_id = $1 ORDER BY issued_at`,
        [userId],
      )) as { outcome: string | null }[];
      expect(outcomes.map((row) => row.outcome)).toEqual(['SUPERSEDED', null]);
      if (first !== second) {
        await expect(verification.verifyEmail(email, PASSWORD, first)).rejects.toThrow(VerificationFailedError);
      }
      await expect(verification.verifyEmail(email, PASSWORD, second)).resolves.toMatchObject({ user: { status: 'ACTIVE' } });
    });

    it('is not issued to a user who is no longer pending', async () => {
      const { userId } = await activeUser();
      const dispatcher = harness.moduleRef.get(GenerateAndDispatchOneTimePasswordService);
      const [event] = (await harness.dataSource.query(`SELECT id FROM outbox_events WHERE aggregate_id = $1 LIMIT 1`, [userId])) as { id: string }[];
      await expect(dispatcher.dispatchEmailVerification(userId, event.id)).resolves.toBe('NOT_PENDING');
    });

    it('resend: 60s cooldown and 5 per hour per email, uniform for unknown emails', async () => {
      const http = request(auth.app.getHttpServer());
      const resend = (email: string) => http.post('/api/v1/auth/resend-otp').send({ email });
      const email = newEmail();
      await accountCreation.register(email, PASSWORD);
      const clearCooldown = async (address: string) => {
        const keys = await redis.keys('rate-limit:verification-email-cooldown:*');
        if (keys.length) await redis.del(...keys);
        return address;
      };
      const first = await resend(email);
      expect(first.status).toBe(202);
      const tooSoon = await resend(email);
      expect(tooSoon.status).toBe(429);
      expect(Number(tooSoon.header['retry-after'])).toBeGreaterThan(50);
      expect(Number(tooSoon.header['retry-after'])).toBeLessThanOrEqual(60);
      // A refused request still counts in the hourly window (hammering is not free):
      // 1 accepted + 1 refused so far, so three more fit in the hour.
      for (let index = 3; index <= 5; index += 1) {
        expect((await resend(await clearCooldown(email))).status).toBe(202);
      }
      const capped = await resend(await clearCooldown(email));
      expect(capped.status).toBe(429);
      expect(Number(capped.header['retry-after'])).toBeGreaterThan(3000);
      // Same behaviour, same bodies, for an email that does not exist.
      const unknown = newEmail();
      const unknownFirst = await resend(unknown);
      expect(unknownFirst.status).toBe(202);
      expect(unknownFirst.body).toEqual(first.body);
      expect((await resend(unknown)).status).toBe(429);
      await auth.deliverOutbox();
      expect(auth.emails.sentTo(unknown)).toHaveLength(0);
    });
  });

  describe('refresh tokens (design §9.1)', () => {
    const liveTokenCount = async (userId: string) =>
      Number(
        (
          (await harness.dataSource.query(
            `SELECT count(*) AS live FROM refresh_tokens JOIN refresh_token_families f ON f.id = refresh_tokens.family_id
              WHERE f.user_id = $1 AND f.revoked_at IS NULL AND refresh_tokens.used_at IS NULL AND refresh_tokens.expires_at > now()`,
            [userId],
          )) as { live: string }[]
        )[0].live,
      );

    it('rotate on every refresh; the old token is then dead, and only hashes are stored', async () => {
      const { userId, refreshToken } = await activeUser();
      const { tokens } = await login.refresh(refreshToken);
      expect(tokens.refresh.token).not.toBe(refreshToken);
      expect(await liveTokenCount(userId)).toBe(1);
      const stored = JSON.stringify(await harness.dataSource.query(`SELECT * FROM refresh_tokens`));
      expect(stored).not.toContain(refreshToken);
      expect(stored).not.toContain(tokens.refresh.token);
    });

    it('reuse of a rotated token revokes the whole family — the legitimate child dies too', async () => {
      const { userId, refreshToken } = await activeUser();
      const { tokens: child } = await login.refresh(refreshToken);
      await expect(login.refresh(refreshToken)).rejects.toThrow(UnauthenticatedError);
      await expect(login.refresh(child.refresh.token)).rejects.toThrow(UnauthenticatedError);
      expect(await liveTokenCount(userId)).toBe(0);
      const [family] = (await harness.dataSource.query(
        `SELECT revocation_reason FROM refresh_token_families WHERE user_id = $1`,
        [userId],
      )) as { revocation_reason: string }[];
      expect(family.revocation_reason).toBe('REUSE_DETECTED');
    });

    it('logout revokes the family: its refresh and access tokens are both refused at once', async () => {
      const { userId, refreshToken, accessToken } = await activeUser();
      const http = request(auth.app.getHttpServer());
      await http.get('/api/v1/users/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
      await http.post('/api/v1/auth/logout').set('Authorization', `Bearer ${accessToken}`).expect(204);
      await http.post('/api/v1/auth/logout').set('Authorization', `Bearer ${accessToken}`).expect(401);
      await http.get('/api/v1/users/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
      await expect(login.refresh(refreshToken)).rejects.toThrow(UnauthenticatedError);
      expect(await liveTokenCount(userId)).toBe(0);
    });

    it('logout of one session leaves the user\'s other sessions alive', async () => {
      const { email, userId, accessToken } = await activeUser();
      const other = await login.login(email, PASSWORD);
      const otherFamilyId = (jsonwebtoken.decode(other.tokens.access.token) as { familyId: string }).familyId;
      await login.logout(userId, otherFamilyId);
      await expect(login.refresh(other.tokens.refresh.token)).rejects.toThrow(UnauthenticatedError);
      await request(auth.app.getHttpServer()).get('/api/v1/users/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
    });

    it('an expired refresh token is refused (and does not revoke the family)', async () => {
      const { refreshToken, userId } = await activeUser();
      auth.clock.advance(7 * 24 * 3600 * 1000 + 1000);
      await expect(login.refresh(refreshToken)).rejects.toThrow(UnauthenticatedError);
      const [family] = (await harness.dataSource.query(`SELECT revoked_at FROM refresh_token_families WHERE user_id = $1`, [userId])) as {
        revoked_at: Date | null;
      }[];
      expect(family.revoked_at).toBeNull();
    });

    it('a suspended user cannot refresh (the family is revoked) and is refused on verified routes, but can log out', async () => {
      const { userId, refreshToken, accessToken } = await activeUser();
      await owner.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [userId]);
      const http = request(auth.app.getHttpServer());
      const refused = await http.get('/api/v1/users/me').set('Authorization', `Bearer ${accessToken}`).expect(403);
      expect(refused.body.code).toBe('ACCOUNT_SUSPENDED');
      await expect(login.refresh(refreshToken)).rejects.toThrow(UnauthenticatedError);
      const [family] = (await harness.dataSource.query(`SELECT revocation_reason FROM refresh_token_families WHERE user_id = $1`, [userId])) as {
        revocation_reason: string;
      }[];
      expect(family.revocation_reason).toBe('USER_NOT_ACTIVE');
      // A second session of the suspended user can still end itself (@AllowUnverified).
      await owner.query(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [userId]);
      const [{ email }] = (await harness.dataSource.query(`SELECT email FROM users WHERE id = $1`, [userId])) as { email: string }[];
      const second = await login.login(email, PASSWORD);
      await owner.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [userId]);
      await http.post('/api/v1/auth/logout').set('Authorization', `Bearer ${second.tokens.access.token}`).expect(204);
      await http.get('/api/v1/users/me').set('Authorization', `Bearer ${second.tokens.access.token}`).expect(401);
    });

    it('garbage and unknown tokens are a uniform 401', async () => {
      for (const token of ['', 'x', 'a'.repeat(43), randomUUID()]) {
        await expect(login.refresh(token)).rejects.toThrow(UnauthenticatedError);
      }
    });
  });

  describe('login', () => {
    it('only ACTIVE users with the right password get a session; every refusal is the same error', async () => {
      const { email } = await activeUser();
      await expect(login.login(email, PASSWORD)).resolves.toMatchObject({ user: { email, status: 'ACTIVE' } });
      const pending = newEmail();
      await accountCreation.register(pending, PASSWORD);
      const errors: unknown[] = await Promise.all([
        login.login(email, 'wrong password here').catch((error: Error) => error),
        login.login(newEmail(), PASSWORD).catch((error: Error) => error),
        login.login(pending, PASSWORD).catch((error: Error) => error),
      ]);
      for (const error of errors) {
        expect(error).toMatchObject({ code: 'INVALID_CREDENTIALS', httpStatus: 401, message: (errors[0] as Error).message });
      }
    });

    it('a hash made with older (weaker) argon2 parameters is replaced at the design parameters on the next login (decision #12)', async () => {
      const { email, userId } = await activeUser();
      const weak = await argon2.hash(PASSWORD.normalize('NFKC'), { type: argon2.argon2id, memoryCost: 4096, timeCost: 1, parallelism: 1 });
      await owner.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, weak]);
      await expect(login.login(email, PASSWORD)).resolves.toMatchObject({ user: { email } });
      const [{ password_hash: rehashed }] = (await owner.query(`SELECT password_hash FROM users WHERE id = $1`, [userId])).rows as { password_hash: string }[];
      expect(rehashed).not.toBe(weak);
      const parameters = /^\$argon2id\$v=19\$([^$]+)\$/.exec(rehashed)![1].split(',').sort();
      expect(parameters).toEqual(['m=19456', 'p=1', 't=2']);
      await expect(login.login(email, PASSWORD)).resolves.toMatchObject({ user: { email } });
    });
  });

  describe('verification races', () => {
    it('a verify that loses the activation race (the user was activated meanwhile) fails as VERIFICATION_FAILED and changes nothing', async () => {
      const { email, code } = await registerWithCode();
      const users = harness.moduleRef.get(UserRepository);
      const activate = jest.spyOn(users, 'activate').mockResolvedValueOnce(null);
      try {
        await expect(harness.moduleRef.get(VerificationService).verifyEmail(email, PASSWORD, code)).rejects.toBeInstanceOf(VerificationFailedError);
      } finally {
        activate.mockRestore();
      }
      const [{ status }] = (await owner.query(`SELECT status FROM users WHERE email = $1`, [email])).rows as { status: string }[];
      expect(status).toBe('PENDING_VERIFICATION');
    });
  });

  describe('demo credit (decision #4)', () => {
    it('is a real PROMOTIONAL posting from EXPENSE:PROMOTIONAL:NGN at verification, and books stay clean', async () => {
      const { email, code } = await registerWithCode();
      const userId = await userIdOf(email);
      const [account] = (await harness.dataSource.query(
        `SELECT accounts.id FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id WHERE wallets.user_id = $1`,
        [userId],
      )) as { id: string }[];
      expect(await harness.balanceOf(account.id)).toBe(0n);
      await verification.verifyEmail(email, PASSWORD, code);
      expect(await harness.balanceOf(account.id)).toBe(DEMO_CREDIT_MINOR);
      const postings = (await harness.dataSource.query(
        `SELECT type, reference, reason_code FROM transactions WHERE user_id = $1`,
        [userId],
      )) as unknown[];
      expect(postings).toEqual([{ type: 'PROMOTIONAL', reference: `demo-credit:${userId}`, reason_code: 'SIGNUP_DEMO_CREDIT' }]);
      await harness.expectCleanBooks();
    });

    it('can never be credited twice to one user, even if called again directly', async () => {
      const { userId } = await activeUser();
      const wallets = harness.moduleRef.get(WalletProvisioningService);
      const unitOfWork = harness.moduleRef.get(UnitOfWork);
      await expect(unitOfWork.run(() => wallets.postDemoCreditIfEnabled(userId))).rejects.toThrow(InvalidPostingError);
      const [row] = (await harness.dataSource.query(`SELECT count(*)::int AS count FROM transactions WHERE user_id = $1`, [userId])) as {
        count: number;
      }[];
      expect(row.count).toBe(1);
      await harness.expectCleanBooks();
    });
  });

  describe('outbox delivery (design §7.6)', () => {
    it('a failed email is retried with backoff and delivered later; nothing is lost', async () => {
      const email = newEmail();
      await accountCreation.register(email, PASSWORD);
      auth.emails.failNext(1);
      await auth.outbox.dispatchDue(100);
      const userId = await userIdOf(email);
      const [failed] = (await harness.dataSource.query(
        `SELECT attempts, published_at, last_error, next_attempt_at > now() + interval '3 seconds' AS backed_off
           FROM outbox_events WHERE aggregate_id = $1`,
        [userId],
      )) as { attempts: number; published_at: Date | null; last_error: string; backed_off: boolean }[];
      expect(failed).toMatchObject({ attempts: 1, published_at: null, backed_off: true });
      expect(failed.last_error).toContain('Injected SMTP failure');
      await harness.dataSource.query(`UPDATE outbox_events SET next_attempt_at = now() WHERE aggregate_id = $1`, [userId]);
      await auth.deliverOutbox();
      expect(auth.emails.sentTo(email)).toHaveLength(1);
      const [delivered] = (await harness.dataSource.query(`SELECT attempts, published_at FROM outbox_events WHERE aggregate_id = $1`, [userId])) as {
        attempts: number;
        published_at: Date | null;
      }[];
      expect(delivered.attempts).toBe(2);
      expect(delivered.published_at).not.toBeNull();
    });

    it('dead-letters after OUTBOX_MAX_ATTEMPTS, keeping the event and its error; the user can still resend', async () => {
      const email = newEmail();
      await accountCreation.register(email, PASSWORD);
      const userId = await userIdOf(email);
      auth.emails.failNext(3);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await harness.dataSource.query(`UPDATE outbox_events SET next_attempt_at = now() WHERE aggregate_id = $1 AND published_at IS NULL AND failed_at IS NULL`, [userId]);
        await auth.outbox.dispatchDue(100);
      }
      const [event] = (await harness.dataSource.query(`SELECT attempts, failed_at, published_at FROM outbox_events WHERE aggregate_id = $1`, [userId])) as {
        attempts: number;
        failed_at: Date | null;
        published_at: Date | null;
      }[];
      expect(event.attempts).toBe(3);
      expect(event.failed_at).not.toBeNull();
      expect(event.published_at).toBeNull();
      await verification.resendVerificationCode(email);
      await auth.deliverOutbox();
      await expect(verification.verifyEmail(email, PASSWORD, auth.emails.latestCodeFor(email))).resolves.toMatchObject({
        user: { status: 'ACTIVE' },
      });
    });

    it('a claimed event whose dispatcher died is redelivered once its lease lapses', async () => {
      const email = newEmail();
      await accountCreation.register(email, PASSWORD);
      const userId = await userIdOf(email);
      // Claim it and "crash": the lease is set, but the event is never marked published.
      await harness.dataSource.query(
        `UPDATE outbox_events SET attempts = attempts + 1, next_attempt_at = now() + interval '60 seconds' WHERE aggregate_id = $1`,
        [userId],
      );
      expect((await auth.outbox.dispatchDue(100)).claimed).toBe(0);
      await harness.dataSource.query(`UPDATE outbox_events SET next_attempt_at = now() WHERE aggregate_id = $1`, [userId]);
      await auth.deliverOutbox();
      expect(auth.emails.sentTo(email)).toHaveLength(1);
    });
  });
});

function transactionsTouch(after: { transactionCount: number }, before: { transactionCount: number }): boolean {
  return after.transactionCount !== before.transactionCount;
}
