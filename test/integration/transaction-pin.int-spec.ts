import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { AccountCreationService } from '../../src/modules/auth/account-creation.service';
import { VerificationService } from '../../src/modules/auth/verification.service';
import {
  FxHarness,
  HARNESS_TRANSACTION_PIN,
  HARNESS_USER_PASSWORD,
  LedgerHarness,
  PaymentsHarness,
  PaystackHarness,
  SignedUpUser,
  WithdrawalsHarness,
  startLedgerHarness,
} from '../support/ledger-harness';

const ACCOUNT_NUMBER = '0123456789';
const NEW_PIN = '518204';

/**
 * The transaction PIN (2026-10-12 decision), end to end through the real HTTP pipeline on real PostgreSQL and Redis:
 * creating, changing and resetting it; every withdrawal, market conversion and quoted trade needing it; a wrong PIN
 * moving nothing; wrong guesses counted even when the request is refused; five in a row locking it until a reset;
 * concurrent guesses counted one by one; a burst larger than the connection pool never waiting on itself; a wrong PIN
 * never burning the emailed withdrawal code; a same-key replay still needing the PIN.
 */
describe('Transaction PIN (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let fx: FxHarness;
  let paystack: PaystackHarness;
  let withdrawals: WithdrawalsHarness;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { fx: true, paystack: { withdrawals: true } });
    payments = harness.payments!;
    fx = harness.fx!;
    paystack = payments.paystack!;
    withdrawals = paystack.withdrawals!;
    paystack.mock.transfers.addAccount('058', ACCOUNT_NUMBER, 'ADA LOVELACE');
    paystack.mock.transfers.setBalance(10n ** 15n);
  }, 180_000);
  afterAll(async () => harness?.close());
  beforeEach(async () => {
    harness.auth!.clock.advance(86_400_000);
    fx.api.clearFaults();
    await fx.resetRedisState();
    await payments.clearRateLimits();
    await fx.warm();
    await withdrawals.beat();
  });

  const http = () => request(harness.auth!.app.getHttpServer());
  const bearer = (user: SignedUpUser) => `Bearer ${user.accessToken}`;
  const me = async (user: SignedUpUser) => (await http().get(`/${API_PREFIX}/users/me`).set('Authorization', bearer(user)).expect(200)).body;
  const pinRoute = (user: SignedUpUser, method: 'post' | 'put', path: string, body?: Record<string, unknown>) =>
    http()[method](`/${API_PREFIX}/users/me/transaction-pin${path}`).set('Authorization', bearer(user)).send(body ?? {});
  const convert = (user: SignedUpUser, transactionPin: string | undefined, key = randomUUID()) =>
    http()
      .post(`/${API_PREFIX}/wallet/convert`)
      .set('Authorization', bearer(user))
      .set('Idempotency-Key', key)
      .send({ from: 'NGN', to: 'USD', sourceAmount: '100000', ...(transactionPin === undefined ? {} : { transactionPin }) });
  const pinRow = async (userId: string) =>
    ((await harness.dataSource.query(`SELECT pin_hash, failed_attempts, locked_at FROM transaction_pins WHERE user_id = $1`, [userId])) as {
      pin_hash: string;
      failed_attempts: number;
      locked_at: Date | null;
    }[])[0];
  const credit = async (user: SignedUpUser, amountMinor = 10_000_000n) => {
    const [row] = (await harness.dataSource.query(
      `SELECT accounts.id AS account_id, wallets.id AS wallet_id FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id
        WHERE wallets.user_id = $1 AND accounts.currency_code = 'NGN'`,
      [user.userId],
    )) as { account_id: string; wallet_id: string }[];
    await harness.fund({ userId: user.userId, walletId: row.wallet_id, accountId: row.account_id, currency: 'NGN' }, amountMinor);
  };
  const conversionsOf = async (userId: string) =>
    ((await harness.dataSource.query(`SELECT count(*)::int AS count FROM transactions WHERE user_id = $1 AND type = 'CONVERSION'`, [userId])) as {
      count: number;
    }[])[0].count;
  /** A verified user WITHOUT a PIN (harness sign-ups get one). */
  const userWithoutPin = async (): Promise<SignedUpUser> => {
    const email = `pinless-${randomUUID().slice(0, 12)}@example.com`;
    await harness.moduleRef.get(AccountCreationService).register(email, HARNESS_USER_PASSWORD);
    await harness.auth!.deliverOutbox();
    const session = await harness.moduleRef
      .get(VerificationService)
      .verifyEmail(email, HARNESS_USER_PASSWORD, harness.auth!.emails.latestCodeFor(email));
    return { userId: session.user.id, email, accessToken: session.tokens.access.token };
  };
  const latestEmail = (user: SignedUpUser) => harness.auth!.emails.sentTo(user.email).at(-1);
  const resetCode = async (user: SignedUpUser) => {
    expect((await pinRoute(user, 'post', '/reset-code')).status).toBe(202);
    await harness.auth!.deliverOutbox();
    const code = /reset your transaction PIN is (\d{6})\./.exec(latestEmail(user)!.text)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    return code!;
  };
  const codeOf = (response: { body: unknown }) => (response.body as { code?: string }).code;

  describe('creating', () => {
    it('until a PIN exists, /users/me says so and every money route refuses with TRANSACTION_PIN_NOT_SET, moving nothing', async () => {
      const user = await userWithoutPin();
      await credit(user);
      expect(await me(user)).toMatchObject({ transactionPinSet: false, transactionPinLocked: false });
      const before = await harness.snapshot();
      const refused = await convert(user, '402815');
      expect([refused.status, codeOf(refused)]).toEqual([409, 'TRANSACTION_PIN_NOT_SET']);
      const trade = await http()
        .post(`/${API_PREFIX}/wallet/trade`)
        .set('Authorization', bearer(user))
        .set('Idempotency-Key', randomUUID())
        .send({ quoteId: randomUUID(), transactionPin: '402815' });
      expect(codeOf(trade)).toBe('TRANSACTION_PIN_NOT_SET');
      expect((await harness.snapshot()).transactionCount).toBe(before.transactionCount);
      // A body without the field never reaches the check: the pipeline refuses it.
      expect(codeOf(await convert(user, undefined))).toBe('VALIDATION_FAILED');
    });

    it('weak PINs and a wrong password are refused; a good one is stored hashed, announced by email and audited — once', async () => {
      const user = await userWithoutPin();
      for (const weak of ['111111', '123456', '987654']) {
        const response = await pinRoute(user, 'post', '', { pin: weak, password: HARNESS_USER_PASSWORD });
        expect([response.status, codeOf(response)]).toEqual([400, 'TRANSACTION_PIN_TOO_WEAK']);
      }
      expect(codeOf(await pinRoute(user, 'post', '', { pin: '12345', password: HARNESS_USER_PASSWORD }))).toBe('VALIDATION_FAILED');
      const wrongPassword = await pinRoute(user, 'post', '', { pin: '402815', password: 'not my password at all' });
      expect([wrongPassword.status, codeOf(wrongPassword)]).toEqual([400, 'PASSWORD_INCORRECT']);
      expect(await pinRow(user.userId)).toBeUndefined();

      const created = await pinRoute(user, 'post', '', { pin: '402815', password: HARNESS_USER_PASSWORD });
      expect([created.status, created.body]).toEqual([201, { set: true, locked: false }]);
      expect(JSON.stringify(created.body)).not.toContain('402815');
      const row = await pinRow(user.userId);
      expect(row.pin_hash).toMatch(/^\$argon2id\$/);
      expect(row.pin_hash).not.toContain('402815');
      expect(await me(user)).toMatchObject({ transactionPinSet: true, transactionPinLocked: false });

      const again = await pinRoute(user, 'post', '', { pin: '402816', password: HARNESS_USER_PASSWORD });
      expect([again.status, codeOf(again)]).toEqual([409, 'TRANSACTION_PIN_ALREADY_SET']);

      await harness.auth!.deliverOutbox();
      expect(latestEmail(user)!.subject).toBe('KoboFX: Your transaction PIN was created');
      expect(latestEmail(user)!.text).not.toContain('402815');
      const audits = (await harness.dataSource.query(
        `SELECT action FROM audit_logs WHERE subject_id = $1 AND action LIKE 'TRANSACTION_PIN_%' ORDER BY occurred_at`,
        [user.userId],
      )) as { action: string }[];
      expect(audits.map((each) => each.action)).toEqual(['TRANSACTION_PIN_CREATED']);
      const anyPin = (await harness.dataSource.query(
        `SELECT count(*)::int AS count FROM audit_logs WHERE after::text LIKE '%402815%' OR reason LIKE '%402815%'`,
      )) as { count: number }[];
      expect(anyPin[0].count).toBe(0);
    });
  });

  describe('verifying', () => {
    it('a wrong PIN moves nothing, is counted even though the request was refused, and a right one resets the count', async () => {
      const user = await payments.signUp();
      await credit(user);
      const before = await harness.snapshot();
      const wrong = await convert(user, '999990');
      expect([wrong.status, codeOf(wrong), wrong.body.details]).toEqual([400, 'TRANSACTION_PIN_INVALID', { attemptsRemaining: 4 }]);
      expect((await harness.snapshot()).transactionCount).toBe(before.transactionCount);
      expect((await pinRow(user.userId)).failed_attempts).toBe(1); // survived the refused request's rollback
      expect(codeOf(await convert(user, '999991'))).toBe('TRANSACTION_PIN_INVALID');
      expect((await pinRow(user.userId)).failed_attempts).toBe(2);

      expect((await convert(user, HARNESS_TRANSACTION_PIN)).status).toBe(201);
      expect((await pinRow(user.userId)).failed_attempts).toBe(0);
      expect(await conversionsOf(user.userId)).toBe(1);
    });

    it('five wrong PINs in a row lock it: even the right PIN is refused, the user is told by email, /users/me shows it', async () => {
      const user = await payments.signUp();
      await credit(user);
      const outcomes: string[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) outcomes.push(`${(await convert(user, '999990')).body.code}`);
      expect(outcomes).toEqual(['TRANSACTION_PIN_INVALID', 'TRANSACTION_PIN_INVALID', 'TRANSACTION_PIN_INVALID', 'TRANSACTION_PIN_INVALID', 'TRANSACTION_PIN_LOCKED']);
      const locked = await convert(user, HARNESS_TRANSACTION_PIN);
      expect([locked.status, codeOf(locked), locked.body.details]).toEqual([423, 'TRANSACTION_PIN_LOCKED', { resetRequired: true }]);
      expect(await conversionsOf(user.userId)).toBe(0);
      expect(await me(user)).toMatchObject({ transactionPinSet: true, transactionPinLocked: true });
      await harness.auth!.deliverOutbox();
      expect(latestEmail(user)!.subject).toBe('KoboFX: Your transaction PIN is locked');
      const [audit] = (await harness.dataSource.query(
        `SELECT actor_type FROM audit_logs WHERE subject_id = $1 AND action = 'TRANSACTION_PIN_LOCKED'`,
        [user.userId],
      )) as { actor_type: string }[];
      expect(audit.actor_type).toBe('SYSTEM');
    });

    it('simultaneous wrong guesses are counted one by one: a burst cannot get past the lock', async () => {
      const user = await payments.signUp();
      await credit(user);
      await Promise.all(Array.from({ length: 12 }, () => harness.dataSource.query('SELECT pg_sleep(0.05)')));
      const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => convert(user, index === 11 ? HARNESS_TRANSACTION_PIN : `9999${String(index).padStart(2, '0')}`)));
      const codes = responses.map((response) => (response.status === 201 ? 'POSTED' : (response.body.code as string)));
      const invalid = codes.filter((code) => code === 'TRANSACTION_PIN_INVALID').length;
      const lockedOut = codes.filter((code) => code === 'TRANSACTION_PIN_LOCKED').length;
      // Exactly four wrong guesses are answered INVALID before the fifth locks it; everything after is LOCKED.
      expect(invalid).toBeLessThanOrEqual(4);
      expect(invalid + lockedOut + codes.filter((code) => code === 'POSTED').length).toBe(12);
      const row = await pinRow(user.userId);
      if (codes.includes('POSTED')) {
        // The right PIN got in before the fifth wrong one: it reset the count; never more than 4 wrong counted after it.
        expect(row.failed_attempts).toBeLessThanOrEqual(4);
      } else {
        expect(row).toMatchObject({ failed_attempts: 5 });
        expect(row.locked_at).not.toBeNull();
        expect(invalid).toBe(4);
      }
    });

    it('a same-key replay with the PIN gets the stored answer and no new effect; without the right PIN it gets nothing', async () => {
      const user = await payments.signUp();
      await credit(user);
      const key = randomUUID();
      const first = await convert(user, HARNESS_TRANSACTION_PIN, key);
      expect(first.status).toBe(201);
      const replay = await convert(user, HARNESS_TRANSACTION_PIN, key);
      expect([replay.status, replay.headers['idempotent-replayed']]).toEqual([201, 'true']);
      expect(replay.body).toEqual(first.body);
      // The PIN is checked before the barrier: whoever presents the key must still know it.
      const wrong = await convert(user, '999990', key);
      expect([wrong.status, codeOf(wrong)]).toEqual([400, 'TRANSACTION_PIN_INVALID']);
      expect(wrong.body).not.toHaveProperty('transactionId');
      expect(await conversionsOf(user.userId)).toBe(1);
    });

    it('a burst of PIN-confirmed conversions larger than the connection pool completes (a request never holds two connections)', async () => {
      const user = await payments.signUp();
      await credit(user, 100_000_000n);
      const poolSize = Number(harness.db.env.DB_POOL_MAX);
      const burst = poolSize * 3;
      await Promise.all(Array.from({ length: poolSize }, () => harness.dataSource.query('SELECT pg_sleep(0.05)')));
      const responses = await Promise.all(Array.from({ length: burst }, () => convert(user, HARNESS_TRANSACTION_PIN)));
      expect(responses.map((response) => response.status)).toEqual(Array.from({ length: burst }, () => 201));
      expect(await conversionsOf(user.userId)).toBe(burst);
      expect((await pinRow(user.userId)).failed_attempts).toBe(0);
    }, 60_000);

    it('withdrawals: a wrong PIN is refused before the emailed code is looked at, so the code still works', async () => {
      const user = await payments.signUp();
      await credit(user, 1_000_000n);
      const added = await withdrawals.addBeneficiary(user, { bankCode: '058', accountNumber: ACCOUNT_NUMBER, currency: 'NGN' });
      const beneficiaryId = (added.body as { beneficiaryId: string }).beneficiaryId;
      await payments.drive({ deliverWebhooks: false });
      const code = (await withdrawals.freshCode(user))!;
      const body = { beneficiaryId, amount: '100000', currency: 'NGN', oneTimePassword: code };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const wrong = await withdrawals.withdraw(user, { ...body, transactionPin: '999990' });
        expect(codeOf(wrong)).toBe('TRANSACTION_PIN_INVALID');
      }
      const accepted = await withdrawals.withdraw(user, { ...body, transactionPin: HARNESS_TRANSACTION_PIN });
      expect(accepted.status).toBe(202);
    });
  });

  describe('changing and resetting', () => {
    it('change: the current PIN is required (a wrong one counts), the new one must differ; afterwards only the new one works', async () => {
      const user = await payments.signUp();
      await credit(user);
      const wrong = await pinRoute(user, 'put', '', { currentPin: '999990', newPin: NEW_PIN });
      expect(codeOf(wrong)).toBe('TRANSACTION_PIN_INVALID');
      expect((await pinRow(user.userId)).failed_attempts).toBe(1);
      expect(codeOf(await pinRoute(user, 'put', '', { currentPin: HARNESS_TRANSACTION_PIN, newPin: HARNESS_TRANSACTION_PIN }))).toBe('TRANSACTION_PIN_TOO_WEAK');
      const changed = await pinRoute(user, 'put', '', { currentPin: HARNESS_TRANSACTION_PIN, newPin: NEW_PIN });
      expect([changed.status, changed.body]).toEqual([200, { set: true, locked: false }]);
      // A retried change (the stored PIN is already the new one) answers its success and counts nothing.
      const retried = await pinRoute(user, 'put', '', { currentPin: HARNESS_TRANSACTION_PIN, newPin: NEW_PIN });
      expect(retried.status).toBe(200);
      expect((await pinRow(user.userId)).failed_attempts).toBe(0);
      expect(codeOf(await convert(user, HARNESS_TRANSACTION_PIN))).toBe('TRANSACTION_PIN_INVALID');
      expect((await convert(user, NEW_PIN)).status).toBe(201);
      await harness.auth!.deliverOutbox();
      expect(harness.auth!.emails.sentTo(user.email).some((email) => email.subject === 'KoboFX: Your transaction PIN was changed')).toBe(true);
    });

    it('reset: password + the emailed code unlock a locked PIN; wrong code or password are refused; a retried reset answers its success', async () => {
      const user = await payments.signUp();
      await credit(user);
      for (let attempt = 0; attempt < 5; attempt += 1) await convert(user, '999990');
      expect(await me(user)).toMatchObject({ transactionPinLocked: true });

      const code = await resetCode(user);
      const wrongCode = code === '000000' ? '000001' : '000000';
      expect(codeOf(await pinRoute(user, 'post', '/reset', { password: HARNESS_USER_PASSWORD, oneTimePassword: wrongCode, newPin: NEW_PIN }))).toBe(
        'TRANSACTION_PIN_RESET_CODE_INVALID',
      );
      expect(codeOf(await pinRoute(user, 'post', '/reset', { password: 'not my password at all', oneTimePassword: code, newPin: NEW_PIN }))).toBe(
        'PASSWORD_INCORRECT',
      );
      const reset = await pinRoute(user, 'post', '/reset', { password: HARNESS_USER_PASSWORD, oneTimePassword: code, newPin: NEW_PIN });
      expect([reset.status, reset.body]).toEqual([200, { set: true, locked: false }]);
      expect(await pinRow(user.userId)).toMatchObject({ failed_attempts: 0, locked_at: null });
      const retried = await pinRoute(user, 'post', '/reset', { password: HARNESS_USER_PASSWORD, oneTimePassword: code, newPin: NEW_PIN });
      expect(retried.status).toBe(200);
      expect((await convert(user, NEW_PIN)).status).toBe(201);
      await harness.auth!.deliverOutbox();
      expect(harness.auth!.emails.sentTo(user.email).some((email) => email.subject === 'KoboFX: Your transaction PIN was reset')).toBe(true);
    });

    it('a user without a PIN cannot ask for a reset code', async () => {
      const user = await userWithoutPin();
      expect(codeOf(await pinRoute(user, 'post', '/reset-code'))).toBe('TRANSACTION_PIN_NOT_SET');
    });
  });

  describe('the database', () => {
    it('the runtime role cannot delete a PIN or move its owner; the lock and the count stay consistent by CHECK', async () => {
      const user = await payments.signUp();
      const app = await harness.db.appClient();
      try {
        await expect(app.query(`DELETE FROM transaction_pins WHERE user_id = $1`, [user.userId])).rejects.toThrow();
        await expect(app.query(`UPDATE transaction_pins SET set_at = now() - interval '1 day' WHERE user_id = $1`, [user.userId])).rejects.toThrow();
        await expect(app.query(`UPDATE transaction_pins SET failed_attempts = 5 WHERE user_id = $1`, [user.userId])).rejects.toThrow(/locked_when_exhausted/);
        await expect(app.query(`UPDATE transaction_pins SET pin_hash = 'plain-402815' WHERE user_id = $1`, [user.userId])).rejects.toThrow(/argon2id/);
      } finally {
        await app.end();
      }
    });
  });
});
