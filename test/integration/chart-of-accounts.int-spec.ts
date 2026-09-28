import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { ErrorCode } from '../../src/common/errors';
import { Money } from '../../src/common/money';
import { AppConfig } from '../../src/config/configuration';
import { ChartOfAccountsService } from '../../src/modules/ledger/chart-of-accounts.service';
import {
  AccountType,
  EntryDirection,
  NormalSide,
  PostingAuthorization,
  TransactionType,
} from '../../src/modules/ledger/ledger.types';
import { bucketForTransaction } from '../../src/modules/ledger/posting/bucket';
import { LedgerHarness, startLedgerHarness } from '../support/ledger-harness';

const BUCKETS = 8;
const TEMPLATES: ReadonlyArray<[string, AccountType, NormalSide]> = [
  ['BANK', AccountType.ASSET, NormalSide.DEBIT],
  ['PSP_RECEIVABLE', AccountType.ASSET, NormalSide.DEBIT],
  ['CLEARING', AccountType.ASSET, NormalSide.DEBIT],
  ['FX_POSITION', AccountType.EQUITY, NormalSide.CREDIT],
  ['REVENUE:FX_SPREAD', AccountType.REVENUE, NormalSide.CREDIT],
  ['EXPENSE:PSP_FEES', AccountType.EXPENSE, NormalSide.DEBIT],
  ['EXPENSE:PROMOTIONAL', AccountType.EXPENSE, NormalSide.DEBIT],
  ['EQUITY:ROUNDING', AccountType.EQUITY, NormalSide.CREDIT],
  ['EXPENSE:WRITE_OFF', AccountType.EXPENSE, NormalSide.DEBIT],
];

describe('Chart of accounts (design §5.1, §6.6)', () => {
  let harness: LedgerHarness;
  let owner: Client;

  beforeAll(async () => {
    harness = await startLedgerHarness({ LEDGER_INTERNAL_BUCKETS: String(BUCKETS) });
    owner = await harness.db.ownerClient();
  });

  afterAll(async () => {
    await owner?.end();
    await harness?.close();
  });

  const serviceWithBuckets = (internalAccountBuckets: number) =>
    new ChartOfAccountsService(harness.unitOfWork, { ledger: { internalAccountBuckets } } as AppConfig);

  it('provisions every template × active currency × bucket at boot', async () => {
    const { rows } = await owner.query(
      `SELECT currency_code, count(*)::int AS count FROM accounts WHERE wallet_id IS NULL GROUP BY currency_code ORDER BY 1`,
    );
    expect(rows).toEqual(['EUR', 'GBP', 'NGN', 'USD'].map((currency) => ({ currency_code: currency, count: TEMPLATES.length * BUCKETS })));
  });

  it.each(TEMPLATES)('%s is %s and %s-normal, non-authorizing, in every bucket', async (template, type, side) => {
    const buckets = await harness.chartOfAccounts.findSystemAccountBuckets(template, 'NGN');
    expect(buckets.map((account) => account.bucket)).toEqual([...Array(BUCKETS).keys()]);
    for (const account of buckets) {
      expect(account).toMatchObject({
        code: `${template}:NGN`,
        accountType: type,
        normalSide: side,
        currencyCode: 'NGN',
        walletId: null,
        authorizesBalance: false,
        balanceMinor: 0n,
        reservedMinor: 0n,
        version: 0,
      });
    }
  });

  it('provisioning is idempotent', async () => {
    expect(await harness.chartOfAccounts.provisionActiveCurrencies()).toBe(0);
  });

  it('adding a currency is data, not code (P8): insert it, provision it, post in it', async () => {
    await owner.query(`INSERT INTO currencies (code, name, symbol, minor_unit) VALUES ('JPY', 'Japanese Yen', '¥', 0)`);
    expect(await harness.chartOfAccounts.provisionCurrency('JPY')).toBe(TEMPLATES.length * BUCKETS);

    const account = await harness.openUserAccount('JPY');
    await harness.fund(account, 5_000n);
    expect(await harness.balanceOf(account.accountId)).toBe(5_000n);
    await harness.expectCleanBooks();
  });

  it('refuses to provision an unknown or inactive currency', async () => {
    await expect(harness.chartOfAccounts.provisionCurrency('XYZ')).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_CURRENCY });
    await owner.query(`INSERT INTO currencies (code, name, symbol, minor_unit, is_active) VALUES ('CHF', 'Swiss Franc', 'Fr', 2, false)`);
    await expect(harness.chartOfAccounts.provisionCurrency('CHF')).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_CURRENCY });
  });

  describe('user accounts', () => {
    it('opens USER:{walletId}:{currency} as a CREDIT-normal, balance-authorizing LIABILITY in bucket 0', async () => {
      const wallet = await harness.createWallet();
      const account = await harness.chartOfAccounts.openUserAccount(wallet.walletId, 'NGN');
      expect(account).toMatchObject({
        code: `USER:${wallet.walletId}:NGN`,
        accountType: AccountType.LIABILITY,
        normalSide: NormalSide.CREDIT,
        walletId: wallet.walletId,
        currencyCode: 'NGN',
        authorizesBalance: true,
        overdraftLimitMinor: 0n,
        bucket: 0,
        balanceMinor: 0n,
      });
      // Idempotent: opening again returns the same account.
      expect((await harness.chartOfAccounts.openUserAccount(wallet.walletId, 'NGN')).id).toBe(account.id);
      // One wallet, several currencies.
      expect((await harness.chartOfAccounts.openUserAccount(wallet.walletId, 'USD')).id).not.toBe(account.id);
    });

    it('refuses an unknown wallet, a malformed wallet id and an unsupported currency', async () => {
      await expect(harness.chartOfAccounts.openUserAccount(randomUUID(), 'NGN')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      await expect(harness.chartOfAccounts.openUserAccount('wallet-1', 'NGN')).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_FAILED,
      });
      const wallet = await harness.createWallet();
      await expect(harness.chartOfAccounts.openUserAccount(wallet.walletId, 'XYZ')).rejects.toMatchObject({
        code: ErrorCode.UNSUPPORTED_CURRENCY,
      });
    });
  });

  it('a posting to a system account lands in the bucket its transaction id selects', async () => {
    const account = await harness.openUserAccount('EUR');
    const posted = await harness.ledger.post({
      transaction: {
        type: TransactionType.PROMOTIONAL,
        authorization: PostingAuthorization.SYSTEM_DRIVEN,
        valueTime: new Date(),
        initiatedBy: 'operator:marketing',
        reasonCode: 'WELCOME_BONUS',
      },
      entries: [
        { account: { systemAccount: 'EXPENSE:PROMOTIONAL' }, direction: EntryDirection.DEBIT, amount: Money.of(500n, 'EUR') },
        { account: { accountId: account.accountId }, direction: EntryDirection.CREDIT, amount: Money.of(500n, 'EUR') },
      ],
    });
    const expectedBucket = bucketForTransaction(posted.transactionId, BUCKETS);
    const buckets = await harness.chartOfAccounts.findSystemAccountBuckets('EXPENSE:PROMOTIONAL', 'EUR');
    expect(buckets.find((bucket) => bucket.balanceMinor !== 0n)).toMatchObject({ bucket: expectedBucket, balanceMinor: 500n });
    expect(posted.entries[0].accountId).toBe(buckets[expectedBucket].id);
  });

  it('refuses to provision with a LOWER bucket count: balances in higher buckets would be stranded', async () => {
    await expect(serviceWithBuckets(BUCKETS - 1).provisionCurrency('NGN')).rejects.toMatchObject({
      code: ErrorCode.INVARIANT_VIOLATION,
    });
  });

  it('raising the bucket count is config plus provisioning (runs last: it changes the bucket set)', async () => {
    expect(await serviceWithBuckets(BUCKETS + 2).provisionCurrency('NGN')).toBe(TEMPLATES.length * 2);
    const buckets = await harness.chartOfAccounts.findSystemAccountBuckets('FX_POSITION', 'NGN');
    expect(buckets).toHaveLength(BUCKETS + 2);
  });
});
