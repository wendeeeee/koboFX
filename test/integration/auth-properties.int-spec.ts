import { createHash, randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import fc from 'fast-check';
import * as jsonwebtoken from 'jsonwebtoken';
import { UnauthenticatedError } from '../../src/common/errors';
import { AccountCreationService } from '../../src/modules/auth/account-creation.service';
import { RegisterDto } from '../../src/modules/auth/dto/auth.dto';
import { LoginService } from '../../src/modules/auth/login.service';
import { VerificationService } from '../../src/modules/auth/verification.service';
import { AuthHarness, LedgerHarness, startLedgerHarness } from '../support/ledger-harness';

const PASSWORD = 'a perfectly long password';
const HOUR = 3600_000;
const REFRESH_TIME_TO_LIVE = 7 * 24 * HOUR;

/** An independent model of refresh token families — written from design §9.1, not from the code. */
interface ModelToken {
  readonly token: string;
  readonly familyId: string;
  used: boolean;
  readonly expiresAt: number;
}

class SessionModel {
  readonly tokens: ModelToken[] = [];
  readonly revokedFamilies = new Set<string>();

  isLive(token: ModelToken, now: number): boolean {
    return !token.used && token.expiresAt > now && !this.revokedFamilies.has(token.familyId);
  }

  liveTokens(now: number): Set<string> {
    return new Set(this.tokens.filter((token) => this.isLive(token, now)).map((token) => token.token));
  }

  /** What a refresh of `token` must do. */
  expectedRefresh(token: ModelToken, now: number): 'ROTATE' | 'REUSE' | 'REFUSE' {
    if (this.revokedFamilies.has(token.familyId)) return 'REFUSE';
    if (token.used) return 'REUSE';
    if (token.expiresAt <= now) return 'REFUSE';
    return 'ROTATE';
  }
}

type Command =
  | { readonly kind: 'login' }
  | { readonly kind: 'refresh'; readonly pick: number; readonly preferLive: boolean }
  | { readonly kind: 'logout'; readonly pick: number }
  | { readonly kind: 'advance'; readonly milliseconds: number };

// Steered: most refreshes target a live token (so rotation happens), the rest any
// token (replays); some clock jumps cross the 7-day expiry, most don't.
const command: fc.Arbitrary<Command> = fc.oneof(
  { weight: 2, arbitrary: fc.constant({ kind: 'login' as const }) },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant('refresh' as const),
      pick: fc.nat(),
      preferLive: fc.integer({ min: 0, max: 9 }).map((roll) => roll < 7),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('logout' as const), pick: fc.nat() }) },
  {
    weight: 2,
    arbitrary: fc
      .oneof(fc.integer({ min: 1, max: 48 }).map((hours) => hours * HOUR), fc.constant(REFRESH_TIME_TO_LIVE + HOUR))
      .map((milliseconds) => ({ kind: 'advance' as const, milliseconds })),
  },
);

describe('authentication properties', () => {
  let harness: LedgerHarness;
  let auth: AuthHarness;
  let accountCreation: AccountCreationService;
  let verification: VerificationService;
  let login: LoginService;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { auth: true });
    auth = harness.auth!;
    accountCreation = harness.moduleRef.get(AccountCreationService);
    verification = harness.moduleRef.get(VerificationService);
    login = harness.moduleRef.get(LoginService);
  });

  afterAll(() => harness?.close());

  const hash = (token: string) => createHash('sha256').update(token).digest('hex');
  const familyOf = (accessToken: string) => (jsonwebtoken.decode(accessToken) as { familyId: string }).familyId;

  async function activeUser(): Promise<{ email: string; userId: string }> {
    const email = `model-${randomUUID().slice(0, 8)}@example.com`;
    await accountCreation.register(email, PASSWORD);
    await auth.deliverOutbox();
    const session = await verification.verifyEmail(email, PASSWORD, auth.emails.latestCodeFor(email));
    return { email, userId: session.user.id };
  }

  /** Live tokens according to the database, at the harness clock's "now". */
  async function databaseLiveHashes(userId: string): Promise<Set<string>> {
    const rows = (await harness.dataSource.query(
      `SELECT encode(refresh_tokens.token_hash, 'hex') AS token_hash
         FROM refresh_tokens JOIN refresh_token_families f ON f.id = refresh_tokens.family_id
        WHERE f.user_id = $1 AND f.revoked_at IS NULL AND refresh_tokens.used_at IS NULL AND refresh_tokens.expires_at > $2`,
      [userId, auth.clock.now()],
    )) as { token_hash: string }[];
    return new Set(rows.map((row) => row.token_hash));
  }

  /**
   * Walked at the start of EVERY run, so each path runs whatever the generated tail does
   * (unseeded runs once missed REFUSE_EXPIRED: a coin toss, not a finding). Token indexes
   * are positions in the model's token list:
   * t0 = login (family 1) → rotate t0 into t1 → replay t0 (REUSE revokes family 1) →
   * t2 = login (family 2) → refresh t1 (REFUSE_REVOKED) → logout family 2 →
   * t3 = login (family 3) → past the refresh lifetime → refresh t3 (REFUSE_EXPIRED).
   */
  const PRELUDE: readonly Command[] = [
    { kind: 'login' },
    { kind: 'refresh', pick: 0, preferLive: true },
    { kind: 'refresh', pick: 0, preferLive: false },
    { kind: 'login' },
    { kind: 'refresh', pick: 1, preferLive: false },
    { kind: 'logout', pick: 1 },
    { kind: 'login' },
    { kind: 'advance', milliseconds: REFRESH_TIME_TO_LIVE + HOUR },
    { kind: 'refresh', pick: 3, preferLive: false },
  ];

  it('for any sequence of login, refresh, replay, logout and expiry, live tokens match the model after every step', async () => {
    const exercised = { ROTATE: 0, REUSE: 0, REFUSE_REVOKED: 0, REFUSE_EXPIRED: 0, LOGOUT: 0 };

    await fc.assert(
      fc.asyncProperty(fc.array(command, { minLength: 4, maxLength: 16 }), async (tail) => {
        const commands = [...PRELUDE, ...tail];
        const before = { ...exercised };
        auth.clock.reset();
        const { email, userId } = await activeUser();
        // The verification session is not part of the model: log it out.
        await harness.dataSource.query(
          `UPDATE refresh_token_families SET revoked_at = now(), revocation_reason = 'LOGOUT' WHERE user_id = $1`,
          [userId],
        );
        const model = new SessionModel();
        const families: string[] = [];

        for (const [index, step] of commands.entries()) {
          if (index === PRELUDE.length) {
            // The prelude walked every path in THIS run.
            for (const path of Object.keys(exercised) as (keyof typeof exercised)[]) {
              expect({ path, ranInPrelude: exercised[path] > before[path] }).toEqual({ path, ranInPrelude: true });
            }
          }
          const now = auth.clock.now().getTime();
          switch (step.kind) {
            case 'login': {
              const session = await login.login(email, PASSWORD);
              const familyId = familyOf(session.tokens.access.token);
              families.push(familyId);
              model.tokens.push({ token: session.tokens.refresh.token, familyId, used: false, expiresAt: now + REFRESH_TIME_TO_LIVE });
              break;
            }
            case 'refresh': {
              if (model.tokens.length === 0) break;
              const live = model.tokens.filter((token) => model.isLive(token, now));
              const pool = step.preferLive && live.length > 0 ? live : model.tokens;
              const target = pool[step.pick % pool.length];
              const expected = model.expectedRefresh(target, now);
              const outcome = await login.refresh(target.token).then(
                (result) => result,
                (error: unknown) => {
                  expect(error).toBeInstanceOf(UnauthenticatedError); // never a 500, never a pass
                  return null;
                },
              );
              if (expected === 'ROTATE') {
                expect(outcome).not.toBeNull();
                target.used = true;
                model.tokens.push({ token: outcome!.tokens.refresh.token, familyId: target.familyId, used: false, expiresAt: now + REFRESH_TIME_TO_LIVE });
                exercised.ROTATE += 1;
              } else {
                expect(outcome).toBeNull();
                if (expected === 'REUSE') {
                  model.revokedFamilies.add(target.familyId);
                  exercised.REUSE += 1;
                } else if (model.revokedFamilies.has(target.familyId)) exercised.REFUSE_REVOKED += 1;
                else exercised.REFUSE_EXPIRED += 1;
              }
              break;
            }
            case 'logout': {
              if (families.length === 0) break;
              const familyId = families[step.pick % families.length];
              await login.logout(userId, familyId);
              model.revokedFamilies.add(familyId);
              exercised.LOGOUT += 1;
              break;
            }
            case 'advance':
              auth.clock.advance(step.milliseconds);
              break;
          }
          // The invariant, after EVERY step (handbook: invariant checks between steps).
          const expectedLive = new Set([...model.liveTokens(auth.clock.now().getTime())].map(hash));
          expect(await databaseLiveHashes(userId)).toEqual(expectedLive);
        }
      }),
      { numRuns: 30 },
    );
    auth.clock.reset();

    // Every interesting path actually ran.
    for (const [path, count] of Object.entries(exercised)) {
      expect({ path, ran: count > 0 }).toEqual({ path, ran: true });
    }
  });

  it('registration is unique by the normalisation rule: any casing or padding of one address is one user; lookalikes are refused', async () => {
    const casing = (email: string) =>
      fc
        .array(fc.boolean(), { minLength: email.length, maxLength: email.length })
        .map((flags) => [...email].map((character, index) => (flags[index] ? character.toUpperCase() : character)).join(''));
    const lookalikes = ['а', 'е', 'о', 'К', 'ſ', 'ı'];

    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-z][a-z0-9]{3,10}$/).chain((local) => {
          const email = `${local}-${randomUUID().slice(0, 6)}@example.com`;
          return fc.tuple(fc.constant(email), fc.array(casing(email), { minLength: 2, maxLength: 4 }), fc.constantFrom('', ' '));
        }),
        fc.constantFrom(...lookalikes),
        async ([email, variants, padding], lookalike) => {
          const registered = await Promise.all(
            variants.map(async (variant) => {
              const dto = plainToInstance(RegisterDto, { email: `${padding}${variant}${padding}`, password: PASSWORD });
              expect(await validate(dto)).toEqual([]);
              return accountCreation.register(dto.email, dto.password);
            }),
          );
          expect(registered.filter((outcome) => outcome === 'CREATED')).toHaveLength(1);
          const [row] = (await harness.dataSource.query(`SELECT count(*)::int AS count FROM users WHERE lower(email) = $1`, [email])) as {
            count: number;
          }[];
          expect(row.count).toBe(1);

          const spoofed = email.replace(/[aeokst]/, lookalike);
          if (spoofed !== email) {
            const dto = plainToInstance(RegisterDto, { email: spoofed, password: PASSWORD });
            expect((await validate(dto)).map((error) => error.property)).toContain('email');
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});
