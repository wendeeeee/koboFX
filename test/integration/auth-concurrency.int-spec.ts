import { randomUUID } from 'node:crypto';
import { UnauthenticatedError } from '../../src/common/errors';
import { AccountCreationService } from '../../src/modules/auth/account-creation.service';
import { VerificationFailedError } from '../../src/modules/auth/auth.errors';
import { LoginService } from '../../src/modules/auth/login.service';
import { OneTimePasswordPurpose } from '../../src/modules/auth/one-time-passwords/one-time-password';
import {
  ChallengeAttempt,
  OneTimePasswordChallengeStore,
} from '../../src/modules/auth/one-time-passwords/one-time-password-challenge.store';
import { VerificationService } from '../../src/modules/auth/verification.service';
import { UserRepository } from '../../src/modules/users/user.repository';
import { RedisService } from '../../src/redis/redis.service';
import { AuthHarness, LedgerHarness, startLedgerHarness } from '../support/ledger-harness';

const POOL_SIZE = 10;
const DEMO_CREDIT_MINOR = 5_000_000n;
const PASSWORD = 'a perfectly long password';

/**
 * Concurrency (design §7.1, §9.1). Every test warms the pool and issues its contending
 * commands back to back (CLAUDE.md lessons from Phases 2–3). Each was shown to fail
 * with its guard removed — see the Phase 4 notes in CLAUDE.md.
 */
describe('authentication concurrency', () => {
  let harness: LedgerHarness;
  let auth: AuthHarness;
  let accountCreation: AccountCreationService;
  let verification: VerificationService;
  let login: LoginService;
  let store: OneTimePasswordChallengeStore;

  beforeAll(async () => {
    harness = await startLedgerHarness(
      { DB_POOL_MAX: String(POOL_SIZE), DEMO_CREDIT_NGN_MINOR: DEMO_CREDIT_MINOR.toString() },
      { auth: true },
    );
    auth = harness.auth!;
    accountCreation = harness.moduleRef.get(AccountCreationService);
    verification = harness.moduleRef.get(VerificationService);
    login = harness.moduleRef.get(LoginService);
    store = harness.moduleRef.get(OneTimePasswordChallengeStore);
  });

  afterAll(() => harness?.close());
  afterEach(() => jest.restoreAllMocks());

  async function warmPool(): Promise<void> {
    await Promise.all(Array.from({ length: POOL_SIZE }, () => harness.dataSource.query('SELECT pg_sleep(0.2)')));
    await harness.moduleRef.get(RedisService).ping();
  }

  const newEmail = () => `race-${randomUUID().slice(0, 8)}@example.com`;

  async function registerWithCode(): Promise<{ email: string; code: string; userId: string }> {
    const email = newEmail();
    await accountCreation.register(email, PASSWORD);
    await auth.deliverOutbox();
    const [user] = (await harness.dataSource.query(`SELECT id FROM users WHERE email = $1`, [email])) as { id: string }[];
    return { email, code: auth.emails.latestCodeFor(email), userId: user.id };
  }

  async function settle<T>(work: Promise<T>[]) {
    const results = await Promise.allSettled(work);
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<T>> => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    return { fulfilled: fulfilled.map((result) => result.value), rejected: rejected.map((result) => result.reason as unknown) };
  }

  it('50 parallel wrong guesses against one challenge: exactly 5 are evaluated, then it is gone; the right code is refused', async () => {
    const { email, code, userId } = await registerWithCode();
    const wrong = code === '000000' ? '000001' : '000000';
    const attempts: ChallengeAttempt[] = [];
    const original = store.attempt.bind(store);
    jest.spyOn(store, 'attempt').mockImplementation(async (...args) => {
      const result = await original(...args);
      attempts.push(result);
      return result;
    });
    await warmPool();

    const { fulfilled, rejected } = await settle(
      Array.from({ length: 50 }, () => verification.verifyEmail(email, PASSWORD, wrong)),
    );

    expect(fulfilled).toHaveLength(0);
    expect(rejected.every((error) => error instanceof VerificationFailedError)).toBe(true);
    const evaluated = attempts.filter((attempt) => attempt.kind === 'EVALUATE');
    expect(evaluated).toHaveLength(5);
    expect(evaluated.map((attempt) => (attempt.kind === 'EVALUATE' ? attempt.attempt : 0)).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(await harness.moduleRef.get(RedisService).client.exists(OneTimePasswordChallengeStore.key(OneTimePasswordPurpose.VERIFY_EMAIL, userId))).toBe(0);
    await expect(verification.verifyEmail(email, PASSWORD, code)).rejects.toThrow(VerificationFailedError);
    const [row] = (await harness.dataSource.query(`SELECT status FROM users WHERE id = $1`, [userId])) as { status: string }[];
    expect(row.status).toBe('PENDING_VERIFICATION');
  });

  it('50 parallel registrations of one email: exactly one user, wallet and account; every caller gets the uniform success', async () => {
    const email = newEmail();
    const before = await harness.snapshot();
    await warmPool();

    const { fulfilled, rejected } = await settle(
      Array.from({ length: 50 }, () => accountCreation.register(email, PASSWORD)),
    );

    expect(rejected).toEqual([]);
    expect(fulfilled.filter((outcome) => outcome === 'CREATED')).toHaveLength(1);
    expect(fulfilled.filter((outcome) => outcome === 'PENDING_RENEWED')).toHaveLength(49);
    const after = await harness.snapshot();
    expect(after.userCount - before.userCount).toBe(1);
    expect(after.walletCount - before.walletCount).toBe(1);
    const [accounts] = (await harness.dataSource.query(
      `SELECT count(*)::int AS count FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id
         JOIN users ON users.id = wallets.user_id WHERE users.email = $1`,
      [email],
    )) as { count: number }[];
    expect(accounts.count).toBe(1);
    await harness.expectCleanBooks();
  });

  it('parallel refreshes with one token: one rotation, the rest are reuse — the family ends revoked, never two live children', async () => {
    const { email, code } = await registerWithCode();
    const session = await verification.verifyEmail(email, PASSWORD, code);
    const token = session.tokens.refresh.token;
    await warmPool();

    const { fulfilled, rejected } = await settle(Array.from({ length: 10 }, () => login.refresh(token)));

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    expect(rejected.every((error) => error instanceof UnauthenticatedError)).toBe(true);
    const [family] = (await harness.dataSource.query(
      `SELECT id, revocation_reason FROM refresh_token_families WHERE user_id = $1`,
      [session.user.id],
    )) as { id: string; revocation_reason: string }[];
    expect(family.revocation_reason).toBe('REUSE_DETECTED');
    const tokens = (await harness.dataSource.query(`SELECT parent_id FROM refresh_tokens WHERE family_id = $1`, [family.id])) as {
      parent_id: string | null;
    }[];
    expect(tokens).toHaveLength(2); // the original and its single child
    await expect(login.refresh(fulfilled[0].tokens.refresh.token)).rejects.toThrow(UnauthenticatedError);
  });

  it('parallel verifies with the correct code: one activation, one audit row, one demo credit', async () => {
    const { email, code, userId } = await registerWithCode();
    const users = harness.moduleRef.get(UserRepository);
    const activate = jest.spyOn(users, 'activate');
    await warmPool();

    const { fulfilled, rejected } = await settle(
      Array.from({ length: 10 }, () => verification.verifyEmail(email, PASSWORD, code)),
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected.every((error) => error instanceof VerificationFailedError)).toBe(true);
    // The Redis compare-and-delete lets exactly one caller through to the database.
    expect(activate).toHaveBeenCalledTimes(1);
    const [audits] = (await harness.dataSource.query(
      `SELECT count(*)::int AS count FROM audit_logs WHERE subject_id = $1 AND action = 'USER_VERIFIED'`,
      [userId],
    )) as { count: number }[];
    expect(audits.count).toBe(1);
    const [credits] = (await harness.dataSource.query(
      `SELECT count(*)::int AS count FROM transactions WHERE user_id = $1 AND type = 'PROMOTIONAL'`,
      [userId],
    )) as { count: number }[];
    expect(credits.count).toBe(1);
    const [account] = (await harness.dataSource.query(
      `SELECT accounts.id FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id WHERE wallets.user_id = $1`,
      [userId],
    )) as { id: string }[];
    expect(await harness.balanceOf(account.id)).toBe(DEMO_CREDIT_MINOR);
    await harness.expectCleanBooks();
  });
});
