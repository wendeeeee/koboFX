import { randomUUID } from 'node:crypto';
import { OneTimePasswordPurpose } from '../../src/modules/auth/one-time-passwords/one-time-password';
import { OneTimePasswordChallengeStore } from '../../src/modules/auth/one-time-passwords/one-time-password-challenge.store';
import { RedisService } from '../../src/redis/redis.service';
import { LedgerHarness, PaymentsHarness, PaystackHarness, SignedUpUser, UserAccount, WithdrawalsHarness, startLedgerHarness } from '../support/ledger-harness';

const ACCOUNT_NUMBER = '0123456789';

/**
 * The withdrawal code (2026-10-07 decision; PiggyVest-style step-up): `POST /wallet/withdraw/one-time-password` asks
 * the worker to email a 6-digit code; `POST /wallet/withdraw/paystack` must carry it. One code = one admitted
 * withdrawal of any amount, 10 minutes, 5 tries, a newer code supersedes; checked inside the idempotency barrier and
 * consumed only when the withdrawal is admitted (a money refusal leaves it usable; a same-key replay needs no code).
 */
describe('Withdrawal code (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let paystack: PaystackHarness;
  let withdrawals: WithdrawalsHarness;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { paystack: { withdrawals: true } });
    payments = harness.payments!;
    paystack = payments.paystack!;
    withdrawals = paystack.withdrawals!;
    paystack.mock.transfers.addAccount('058', ACCOUNT_NUMBER, 'ADA LOVELACE');
    paystack.mock.transfers.setBalance(10n ** 15n);
  });
  afterAll(async () => harness?.close());
  beforeEach(async () => {
    paystack.mock.transfers.setNextTransfer({ status: 'success', fee: 1_000n, domain: 'test' });
    await payments.clearRateLimits();
    await withdrawals.beat();
  });

  const emails = () => harness.auth!.emails;
  const redis = () => harness.moduleRef.get(RedisService);
  const codeKey = (userId: string) => OneTimePasswordChallengeStore.key(OneTimePasswordPurpose.AUTHORIZE_WITHDRAWAL, userId);
  const holdsOf = async (accountId: string) =>
    ((await harness.dataSource.query(`SELECT count(*)::int AS count FROM reservations WHERE account_id = $1 AND status = 'ACTIVE'`, [accountId])) as {
      count: number;
    }[])[0].count;

  const ready = async (fundedMinor = 1_000_000n): Promise<{ user: SignedUpUser; account: UserAccount; beneficiaryId: string }> => {
    const user = await payments.signUp();
    const [row] = (await harness.dataSource.query(
      `SELECT accounts.id AS account_id, wallets.id AS wallet_id FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id
        WHERE wallets.user_id = $1 AND accounts.currency_code = 'NGN'`,
      [user.userId],
    )) as { account_id: string; wallet_id: string }[];
    const account = { userId: user.userId, walletId: row.wallet_id, accountId: row.account_id, currency: 'NGN' };
    await harness.fund(account, fundedMinor);
    const added = await withdrawals.addBeneficiary(user, { bankCode: '058', accountNumber: ACCOUNT_NUMBER, currency: 'NGN' });
    const beneficiaryId = (added.body as { beneficiaryId: string }).beneficiaryId;
    await payments.drive({ deliverWebhooks: false });
    return { user, account, beneficiaryId };
  };
  const withdraw = (user: SignedUpUser, beneficiaryId: string, amount: string, oneTimePassword: string, key = randomUUID()) =>
    withdrawals.withdraw(user, { beneficiaryId, amount, currency: 'NGN', oneTimePassword }, key);
  const codeOf = (response: { body: unknown }) => (response.body as { code?: string }).code;

  it('asking for a code: 202, then the WORKER emails it; the plaintext is never stored (only the outbox id and a challenge row)', async () => {
    const { user } = await ready();
    const asked = await withdrawals.requestCode(user);
    expect(asked.status).toBe(202);
    expect(asked.body).toEqual({ status: 'REQUESTED', channel: 'EMAIL', expiresInSeconds: 600 });
    const before = emails().sentTo(user.email).length;
    await harness.auth!.deliverOutbox();
    const code = emails().latestWithdrawalCodeFor(user.email);
    expect(code).toMatch(/^\d{6}$/);
    expect(emails().sentTo(user.email).length).toBe(before + 1);
    expect(emails().sentTo(user.email).at(-1)!.subject).toBe('Your KoboFX withdrawal code');

    const [outbox] = (await harness.dataSource.query(
      `SELECT payload FROM outbox_events WHERE event_type = 'WithdrawalCodeRequested.v1' AND aggregate_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [user.userId],
    )) as { payload: Record<string, unknown> }[];
    expect(outbox.payload).toEqual({ userId: user.userId });
    const [challenge] = (await harness.dataSource.query(
      `SELECT to_jsonb(one_time_password_challenges) AS row FROM one_time_password_challenges
        WHERE user_id = $1 AND purpose = 'AUTHORIZE_WITHDRAWAL' AND outcome IS NULL`,
      [user.userId],
    )) as { row: Record<string, unknown> }[];
    expect(JSON.stringify(challenge.row)).not.toContain(code);
    const stored = await redis().client.hgetall(codeKey(user.userId));
    expect(JSON.stringify(stored)).not.toContain(code); // only its HMAC
  });

  it('no code, a malformed code: 400 VALIDATION_FAILED; a wrong code: 400 WITHDRAWAL_CODE_INVALID, nothing held; the right one: 202', async () => {
    const { user, account, beneficiaryId } = await ready();
    const code = (await withdrawals.freshCode(user))!;
    const missing = await withdrawals.withdraw(user, { beneficiaryId, amount: '100000', currency: 'NGN', oneTimePassword: undefined });
    expect([missing.status, codeOf(missing)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(codeOf(await withdraw(user, beneficiaryId, '100000', '12345'))).toBe('VALIDATION_FAILED');
    const wrong = code === '000000' ? '000001' : '000000';
    const key = randomUUID();
    const refused = await withdraw(user, beneficiaryId, '100000', wrong, key);
    expect([refused.status, codeOf(refused)]).toEqual([400, 'WITHDRAWAL_CODE_INVALID']);
    expect(JSON.stringify(refused.body)).not.toContain(code);
    expect(await holdsOf(account.accountId)).toBe(0);
    // A permanent refusal is stored for its key: the same key + same body replays it.
    const replayed = await withdraw(user, beneficiaryId, '100000', wrong, key);
    expect([replayed.status, replayed.headers['idempotent-replayed']]).toEqual([400, 'true']);
    // A new key with the right code goes through.
    const accepted = await withdraw(user, beneficiaryId, '100000', code);
    expect(accepted.status).toBe(202);
    expect(await holdsOf(account.accountId)).toBe(1);
  });

  it('one code, one withdrawal: used once, a second withdrawal with it is refused — but the first one\'s key still replays its 202', async () => {
    const { user, account, beneficiaryId } = await ready();
    const code = (await withdrawals.freshCode(user))!;
    const key = randomUUID();
    const first = await withdraw(user, beneficiaryId, '100000', code, key);
    expect(first.status).toBe(202);
    expect(await redis().client.exists(codeKey(user.userId))).toBe(0);
    const again = await withdraw(user, beneficiaryId, '100000', code);
    expect([again.status, codeOf(again)]).toEqual([400, 'WITHDRAWAL_CODE_INVALID']);
    const replay = await withdraw(user, beneficiaryId, '100000', code, key);
    expect([replay.status, replay.headers['idempotent-replayed']]).toEqual([202, 'true']);
    expect(replay.body).toEqual(first.body);
    expect(await holdsOf(account.accountId)).toBe(1);
    const [challenge] = (await harness.dataSource.query(
      `SELECT outcome::text AS outcome FROM one_time_password_challenges WHERE user_id = $1 AND purpose = 'AUTHORIZE_WITHDRAWAL' ORDER BY issued_at DESC LIMIT 1`,
      [user.userId],
    )) as { outcome: string }[];
    expect(challenge.outcome).toBe('CONSUMED');
  });

  it('a money refusal (insufficient funds) leaves the code usable for a smaller amount', async () => {
    const { user, account, beneficiaryId } = await ready(200_000n);
    const code = (await withdrawals.freshCode(user))!;
    const tooMuch = await withdraw(user, beneficiaryId, '300000', code);
    expect(codeOf(tooMuch)).toBe('INSUFFICIENT_FUNDS');
    const fits = await withdraw(user, beneficiaryId, '150000', code);
    expect(fits.status).toBe(202);
    expect(await harness.reservedOf(account.accountId)).toBe(150_000n);
  });

  it('five wrong tries use the code up: the right code is refused afterwards', async () => {
    const { user, account, beneficiaryId } = await ready();
    const code = (await withdrawals.freshCode(user))!;
    const wrong = code === '111111' ? '222222' : '111111';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(codeOf(await withdraw(user, beneficiaryId, '100000', wrong))).toBe('WITHDRAWAL_CODE_INVALID');
    }
    expect(codeOf(await withdraw(user, beneficiaryId, '100000', code))).toBe('WITHDRAWAL_CODE_INVALID');
    expect(await holdsOf(account.accountId)).toBe(0);
  });

  it('a newer code supersedes the older one; an expired code is refused', async () => {
    const { user, beneficiaryId } = await ready();
    const older = (await withdrawals.freshCode(user))!;
    const newer = (await withdrawals.freshCode(user))!;
    if (older !== newer) expect(codeOf(await withdraw(user, beneficiaryId, '100000', older))).toBe('WITHDRAWAL_CODE_INVALID');
    const [superseded] = (await harness.dataSource.query(
      `SELECT count(*)::int AS count FROM one_time_password_challenges WHERE user_id = $1 AND purpose = 'AUTHORIZE_WITHDRAWAL' AND outcome = 'SUPERSEDED'`,
      [user.userId],
    )) as { count: number }[];
    expect(superseded.count).toBeGreaterThanOrEqual(1);
    // Expiry is Redis' TTL: shorten it to nothing.
    await redis().client.pexpire(codeKey(user.userId), 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(codeOf(await withdraw(user, beneficiaryId, '100000', newer))).toBe('WITHDRAWAL_CODE_INVALID');
  });

  it('asking for codes is limited: one a minute per user (429)', async () => {
    const { user } = await ready();
    expect((await withdrawals.requestCode(user)).status).toBe(202);
    const second = await withdrawals.requestCode(user);
    expect([second.status, codeOf(second)]).toEqual([429, 'RATE_LIMITED']);
  });

  it('a user suspended before the worker runs gets no code; while admissions are off there is no code to ask for', async () => {
    const { user } = await ready();
    expect((await withdrawals.requestCode(user)).status).toBe(202);
    const owner = await harness.db.ownerClient();
    try {
      await owner.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [user.userId]);
    } finally {
      await owner.end();
    }
    const before = emails().sentTo(user.email).length;
    await harness.auth!.deliverOutbox();
    expect(emails().sentTo(user.email).length).toBe(before);

    const { user: other } = await ready();
    await harness.dataSource.query(`UPDATE worker_capabilities SET heartbeat_at = now() - interval '1 hour'`);
    try {
      await payments.clearRateLimits();
      const refused = await withdrawals.requestCode(other);
      expect([refused.status, codeOf(refused)]).toEqual([503, 'WITHDRAWALS_DISABLED']);
    } finally {
      await withdrawals.beat();
    }
  });

  it('the withdraw key row hashes the body (which holds the code) with the keyed HMAC, never a plain SHA-256', async () => {
    const { user, beneficiaryId } = await ready();
    const key = randomUUID();
    expect((await withdrawals.withdraw(user, { beneficiaryId, amount: '100000', currency: 'NGN' }, key)).status).toBe(202);
    const [row] = (await harness.dataSource.query(`SELECT request_hash_algorithm::text AS algorithm FROM idempotency_keys WHERE key = $1`, [key])) as {
      algorithm: string;
    }[];
    expect(row.algorithm).toBe('HMAC_SHA256_V1');
  });
});
