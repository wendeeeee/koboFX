import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import type { DestinationStream } from 'pino';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { Clock } from '../../src/common/clock';
import { EmailSender } from '../../src/modules/notifications/email/email-sender';
import { OutboxDispatcher } from '../../src/modules/outbox/outbox-dispatcher';
import { Money } from '../../src/common/money';
import { ConfigModule } from '../../src/config/config.module';
import { DatabaseModule } from '../../src/database/database.module';
import { UnitOfWork } from '../../src/database/transaction/unit-of-work';
import { ChartOfAccountsService } from '../../src/modules/ledger/chart-of-accounts.service';
import { LedgerChecksService, LedgerIntegrityReport } from '../../src/modules/ledger/ledger-checks.service';
import { LedgerModule } from '../../src/modules/ledger/ledger.module';
import { LedgerService } from '../../src/modules/ledger/ledger.service';
import {
  EntryDirection,
  PostedTransaction,
  PostingAuthorization,
  TransactionType,
} from '../../src/modules/ledger/ledger.types';
import { ReservationChecksService } from '../../src/modules/reservations/reservation-checks.service';
import { ReservationService } from '../../src/modules/reservations/reservation.service';
import { ReservationsModule } from '../../src/modules/reservations/reservations.module';
import { CapturingEmailSender, TestClock } from './auth-test-doubles';
import { TestDatabase, startTestDatabase } from './test-database';

/** A structurally valid argon2id PHC string for users created outside the auth flow. */
export const PLACEHOLDER_PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$aGFybmVzcw$aGFybmVzcw';

export interface UserAccount {
  readonly userId: string;
  readonly walletId: string;
  readonly accountId: string;
  readonly currency: string;
}

/** Everything a posting or a reservation could have touched. Equal snapshots ⇒ nothing was written. */
export interface LedgerSnapshot {
  readonly transactionCount: number;
  readonly entryCount: number;
  readonly accountsDigest: string;
  readonly transactionsDigest: string;
  readonly reservationsDigest: string;
  readonly userCount: number;
  readonly walletCount: number;
  readonly outboxEventCount: number;
  readonly auditLogCount: number;
}

/**
 * The full application — every module, the real HTTP pipeline, a real Redis — with
 * email captured and the clock controllable. Present when the harness was started
 * with `{ auth: true }`.
 */
export interface AuthHarness {
  readonly app: NestExpressApplication;
  readonly redis: StartedRedisContainer;
  readonly emails: CapturingEmailSender;
  readonly clock: TestClock;
  readonly outbox: OutboxDispatcher;
  /** Deliver every due outbox event (the worker's job), until none are left. */
  deliverOutbox(): Promise<void>;
}

export interface HarnessOptions {
  readonly auth?: boolean;
  readonly logStream?: DestinationStream;
}

export interface LedgerHarness {
  readonly db: TestDatabase;
  readonly moduleRef: TestingModule;
  readonly dataSource: DataSource;
  readonly unitOfWork: UnitOfWork;
  readonly ledger: LedgerService;
  readonly chartOfAccounts: ChartOfAccountsService;
  readonly checks: LedgerChecksService;
  readonly reservations: ReservationService;
  readonly reservationChecks: ReservationChecksService;
  /** Only with `{ auth: true }`. */
  readonly auth: AuthHarness | undefined;
  createWallet(): Promise<{ userId: string; walletId: string }>;
  openUserAccount(currency: string, wallet?: { userId: string; walletId: string }): Promise<UserAccount>;
  /** System-driven funding: DEBIT BANK:{currency} (asset up), CREDIT the user (we owe more). */
  fund(account: UserAccount, amountMinor: bigint): Promise<PostedTransaction>;
  balanceOf(accountId: string): Promise<bigint>;
  reservedOf(accountId: string): Promise<bigint>;
  snapshot(): Promise<LedgerSnapshot>;
  /**
   * Run every §8.1 check — the ledger's and reservations' `reserved = Σ ACTIVE` —
   * and fail the test with the full report if the books are not clean.
   */
  expectCleanBooks(): Promise<LedgerIntegrityReport>;
  close(): Promise<void>;
}

export async function startLedgerHarness(
  overrides: Record<string, string> = {},
  options: HarnessOptions = {},
): Promise<LedgerHarness> {
  const redis = options.auth ? await new RedisContainer('redis:7-alpine').start() : undefined;
  const db = await startTestDatabase({
    ...(redis ? { REDIS_URL: redis.getConnectionUrl() } : {}),
    ...overrides,
  });
  let moduleRef: TestingModule;
  let auth: AuthHarness | undefined;
  if (redis) {
    const emails = new CapturingEmailSender();
    const clock = new TestClock();
    moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(db.env, { logStream: options.logStream })],
    })
      .overrideProvider(EmailSender)
      .useValue(emails)
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app);
    await app.init();
    const outbox = moduleRef.get(OutboxDispatcher);
    auth = {
      app,
      redis,
      emails,
      clock,
      outbox,
      async deliverOutbox() {
        while ((await outbox.dispatchDue(100)).claimed > 0) {
          // keep draining
        }
      },
    };
  } else {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(db.env), DatabaseModule, LedgerModule, ReservationsModule],
    }).compile();
    await moduleRef.init();
  }

  const dataSource = moduleRef.get(DataSource);
  const ledger = moduleRef.get(LedgerService);
  const chartOfAccounts = moduleRef.get(ChartOfAccountsService);
  const checks = moduleRef.get(LedgerChecksService);
  const reservationChecks = moduleRef.get(ReservationChecksService);

  const createWallet = async () => {
    const [user] = (await dataSource.query(
      `INSERT INTO users (email, password_hash)
       VALUES ('ledger-' || gen_random_uuid() || '@example.com', $1) RETURNING id`,
      [PLACEHOLDER_PASSWORD_HASH],
    )) as { id: string }[];
    const [wallet] = (await dataSource.query(`INSERT INTO wallets (user_id) VALUES ($1) RETURNING id`, [
      user.id,
    ])) as { id: string }[];
    return { userId: user.id, walletId: wallet.id };
  };

  const harness: LedgerHarness = {
    db,
    moduleRef,
    dataSource,
    unitOfWork: moduleRef.get(UnitOfWork),
    ledger,
    chartOfAccounts,
    checks,
    reservations: moduleRef.get(ReservationService),
    reservationChecks,
    auth,
    createWallet,
    async openUserAccount(currency, wallet) {
      const owner = wallet ?? (await createWallet());
      const account = await chartOfAccounts.openUserAccount(owner.walletId, currency);
      return { ...owner, accountId: account.id, currency };
    },
    fund(account, amountMinor) {
      return ledger.post({
        transaction: {
          type: TransactionType.FUNDING,
          authorization: PostingAuthorization.SYSTEM_DRIVEN,
          valueTime: new Date(),
          initiatedBy: 'job:test-funding',
          userId: account.userId,
        },
        entries: [
          { account: { systemAccount: 'BANK' }, direction: EntryDirection.DEBIT, amount: Money.of(amountMinor, account.currency) },
          { account: { accountId: account.accountId }, direction: EntryDirection.CREDIT, amount: Money.of(amountMinor, account.currency) },
        ],
      });
    },
    async balanceOf(accountId) {
      const [row] = (await dataSource.query(`SELECT balance_minor::text AS balance FROM accounts WHERE id = $1`, [
        accountId,
      ])) as { balance: string }[];
      return BigInt(row.balance);
    },
    async reservedOf(accountId) {
      const [row] = (await dataSource.query(`SELECT reserved_minor::text AS reserved FROM accounts WHERE id = $1`, [
        accountId,
      ])) as { reserved: string }[];
      return BigInt(row.reserved);
    },
    async snapshot() {
      const [row] = (await dataSource.query(`
        SELECT (SELECT count(*) FROM transactions)::int   AS transaction_count,
               (SELECT count(*) FROM ledger_entries)::int AS entry_count,
               (SELECT md5(coalesce(string_agg(
                  id::text || ':' || balance_minor || ':' || reserved_minor || ':' || version || ':' || coalesce(balance_entry_id::text, '-'),
                  ',' ORDER BY id), '')) FROM accounts) AS accounts_digest,
               (SELECT md5(coalesce(string_agg(
                  id::text || ':' || status || ':' || coalesce(corrected_by_transaction_id::text, '-'),
                  ',' ORDER BY id), '')) FROM transactions) AS transactions_digest,
               (SELECT md5(coalesce(string_agg(
                  id::text || ':' || status || ':' || coalesce(settled_minor::text, '-') || ':' ||
                  coalesce(settlement_transaction_id::text, '-') || ':' || coalesce(resolved_at::text, '-'),
                  ',' ORDER BY id), '')) FROM reservations) AS reservations_digest,
               (SELECT count(*) FROM users)::int         AS user_count,
               (SELECT count(*) FROM wallets)::int       AS wallet_count,
               (SELECT count(*) FROM outbox_events)::int AS outbox_event_count,
               (SELECT count(*) FROM audit_logs)::int    AS audit_log_count
      `)) as {
        transaction_count: number;
        entry_count: number;
        accounts_digest: string;
        transactions_digest: string;
        reservations_digest: string;
        user_count: number;
        wallet_count: number;
        outbox_event_count: number;
        audit_log_count: number;
      }[];
      return {
        transactionCount: row.transaction_count,
        entryCount: row.entry_count,
        accountsDigest: row.accounts_digest,
        transactionsDigest: row.transactions_digest,
        reservationsDigest: row.reservations_digest,
        userCount: row.user_count,
        walletCount: row.wallet_count,
        outboxEventCount: row.outbox_event_count,
        auditLogCount: row.audit_log_count,
      };
    },
    async expectCleanBooks() {
      const report = await checks.runAllChecks();
      expect({
        unbalancedCurrencies: report.unbalancedCurrencies,
        accountingEquationFailures: report.accountingEquationFailures,
        cachedBalanceMismatches: report.cachedBalanceMismatches,
        balanceContinuityBreaks: report.balanceContinuityBreaks,
        hashChainBreaks: report.hashChainBreaks,
        reservedBalanceMismatches: await reservationChecks.findReservedBalanceMismatches(),
      }).toEqual({
        unbalancedCurrencies: [],
        accountingEquationFailures: [],
        cachedBalanceMismatches: [],
        balanceContinuityBreaks: [],
        hashChainBreaks: [],
        reservedBalanceMismatches: [],
      });
      expect(report.isClean).toBe(true);
      return report;
    },
    async close() {
      if (auth) await auth.app.close();
      else await moduleRef.close();
      await db.stop();
      await redis?.stop().catch(() => undefined);
    },
  };
  return harness;
}
