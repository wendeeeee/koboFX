import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { EntityManager, IsNull } from 'typeorm';
import { InvariantViolationError, NotFoundError, UnsupportedCurrencyError, ValidationError } from '../../common/errors';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { sqlState } from '../../database/database-errors';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { AccountEntity } from './entities/account.entity';
import { systemAccountCode, userAccountCode } from './posting/bucket';
import { isUuid } from './posting/posting-validation';

/**
 * The chart of accounts:
 *
 * - Internal accounts come from `system_account_templates` rows × currency × bucket,
 *   so adding a currency is data, not code. insert the currency, then
 *   `provisionCurrency(code)`. Provisioning is idempotent and runs for every active
 *   currency at boot.
 * - A user account `USER:{walletId}:{currency}` is a LIABILITY,
 *   CREDIT-normal, balance-authorizing, in bucket 0.
 *
 * Creating an account row is not a balance change. Every account starts at zero, and
 * only `LedgerService.post()` moves it.
 */
@Injectable()
export class ChartOfAccountsService implements OnApplicationBootstrap {
  private readonly bucketCount: number;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.bucketCount = config.ledger.internalAccountBuckets;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.provisionActiveCurrencies();
  }

  /** Provision internal accounts for every active currency. Returns the number of rows created. */
  async provisionActiveCurrencies(): Promise<number> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT code FROM currencies WHERE is_active ORDER BY code`,
    )) as { code: string }[];
    let created = 0;
    for (const { code } of rows) created += await this.provisionCurrency(code);
    return created;
  }

  /** Create any missing internal accounts (all templates × all buckets) for one currency. */
  async provisionCurrency(currency: string): Promise<number> {
    return this.unitOfWork.run(async (manager) => {
      await this.assertActiveCurrency(manager, currency);
      await this.assertBucketCountNotLowered(manager);
      const created = (await manager.query(
        `INSERT INTO accounts (code, account_type, normal_side, currency_code, authorizes_balance, bucket)
         SELECT template.name || ':' || $1::text, template.account_type, template.normal_side, $1::text, FALSE, bucket
           FROM system_account_templates template
          CROSS JOIN generate_series(0, $2::integer - 1) AS bucket
         ON CONFLICT (code, bucket) DO NOTHING
         RETURNING id`,
        [currency, this.bucketCount],
      )) as unknown[];
      return created.length;
    });
  }

  /** Open (or return the existing) user account for a wallet in one currency. */
  async openUserAccount(walletId: string, currency: string): Promise<AccountEntity> {
    if (!isUuid(walletId)) throw new ValidationError('walletId must be a UUID.', { walletId: String(walletId) });
    return this.unitOfWork.run(async (manager) => {
      await this.assertActiveCurrency(manager, currency);
      try {
        await manager.query(
          `INSERT INTO accounts
             (code, account_type, normal_side, wallet_id, currency_code, authorizes_balance, bucket)
           VALUES ($1, 'LIABILITY', 'CREDIT', $2, $3, TRUE, 0)
           ON CONFLICT DO NOTHING`,
          // No conflict target on purpose: two racing opens can collide on EITHER unique index — (wallet_id,
          // currency_code) or accounts_code_bucket_unique — and Postgres only absorbs a conflict on the named arbiter.
          // The code embeds the wallet id, so any conflict means this account already exists; the read below fails
          // loudly if it somehow does not.
          [userAccountCode(walletId.toLowerCase(), currency), walletId, currency],
        );
      } catch (error) {
        if (sqlState(error) === '23503') {
          throw new NotFoundError('Wallet not found.', { walletId }, { cause: error });
        }
        throw error;
      }
      return manager.findOneByOrFail(AccountEntity, { walletId, currencyCode: currency });
    });
  }

  /** Every bucket row of one internal account, in bucket order. */
  async findSystemAccountBuckets(systemAccount: string, currency: string): Promise<AccountEntity[]> {
    return this.unitOfWork.manager.find(AccountEntity, {
      where: { code: systemAccountCode(systemAccount, currency), walletId: IsNull() },
      order: { bucket: 'ASC' },
    });
  }

  private async assertActiveCurrency(manager: EntityManager, currency: string): Promise<void> {
    const [row] = (await manager.query(`SELECT is_active FROM currencies WHERE code = $1`, [currency])) as {
      is_active: boolean;
    }[];
    if (!row?.is_active) throw new UnsupportedCurrencyError(currency);
  }

 
  private async assertBucketCountNotLowered(manager: EntityManager): Promise<void> {
    const [row] = (await manager.query(
      `SELECT max(bucket) AS highest_bucket FROM accounts WHERE wallet_id IS NULL`,
    )) as { highest_bucket: number | null }[];
    if (row.highest_bucket !== null && row.highest_bucket >= this.bucketCount) {
      throw new InvariantViolationError(
        'LEDGER_INTERNAL_BUCKETS is lower than the buckets already provisioned; balances would be stranded.',
        { configuredBuckets: this.bucketCount, highestExistingBucket: row.highest_bucket },
      );
    }
  }
}
