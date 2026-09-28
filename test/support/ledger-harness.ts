import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
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
import { TestDatabase, startTestDatabase } from './test-database';

export interface UserAccount {
  readonly userId: string;
  readonly walletId: string;
  readonly accountId: string;
  readonly currency: string;
}

/** Everything a posting could have touched. Equal snapshots ⇒ nothing was written. */
export interface LedgerSnapshot {
  readonly transactionCount: number;
  readonly entryCount: number;
  readonly accountsDigest: string;
  readonly transactionsDigest: string;
}

export interface LedgerHarness {
  readonly db: TestDatabase;
  readonly moduleRef: TestingModule;
  readonly dataSource: DataSource;
  readonly unitOfWork: UnitOfWork;
  readonly ledger: LedgerService;
  readonly chartOfAccounts: ChartOfAccountsService;
  readonly checks: LedgerChecksService;
  createWallet(): Promise<{ userId: string; walletId: string }>;
  openUserAccount(currency: string, wallet?: { userId: string; walletId: string }): Promise<UserAccount>;
  /** System-driven funding: DEBIT BANK:{currency} (asset up), CREDIT the user (we owe more). */
  fund(account: UserAccount, amountMinor: bigint): Promise<PostedTransaction>;
  balanceOf(accountId: string): Promise<bigint>;
  snapshot(): Promise<LedgerSnapshot>;
  /** Run every §8.1 check; fail the test with the full report if the books are not clean. */
  expectCleanBooks(): Promise<LedgerIntegrityReport>;
  close(): Promise<void>;
}

export async function startLedgerHarness(overrides: Record<string, string> = {}): Promise<LedgerHarness> {
  const db = await startTestDatabase(overrides);
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot(db.env), DatabaseModule, LedgerModule],
  }).compile();
  await moduleRef.init();

  const dataSource = moduleRef.get(DataSource);
  const ledger = moduleRef.get(LedgerService);
  const chartOfAccounts = moduleRef.get(ChartOfAccountsService);
  const checks = moduleRef.get(LedgerChecksService);

  const createWallet = async () => {
    const [user] = (await dataSource.query(`INSERT INTO users DEFAULT VALUES RETURNING id`)) as { id: string }[];
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
    async snapshot() {
      const [row] = (await dataSource.query(`
        SELECT (SELECT count(*) FROM transactions)::int   AS transaction_count,
               (SELECT count(*) FROM ledger_entries)::int AS entry_count,
               (SELECT md5(coalesce(string_agg(
                  id::text || ':' || balance_minor || ':' || reserved_minor || ':' || version || ':' || coalesce(balance_entry_id::text, '-'),
                  ',' ORDER BY id), '')) FROM accounts) AS accounts_digest,
               (SELECT md5(coalesce(string_agg(
                  id::text || ':' || status || ':' || coalesce(corrected_by_transaction_id::text, '-'),
                  ',' ORDER BY id), '')) FROM transactions) AS transactions_digest
      `)) as { transaction_count: number; entry_count: number; accounts_digest: string; transactions_digest: string }[];
      return {
        transactionCount: row.transaction_count,
        entryCount: row.entry_count,
        accountsDigest: row.accounts_digest,
        transactionsDigest: row.transactions_digest,
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
      }).toEqual({
        unbalancedCurrencies: [],
        accountingEquationFailures: [],
        cachedBalanceMismatches: [],
        balanceContinuityBreaks: [],
        hashChainBreaks: [],
      });
      expect(report.isClean).toBe(true);
      return report;
    },
    async close() {
      await moduleRef.close();
      await db.stop();
    },
  };
  return harness;
}
