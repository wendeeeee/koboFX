import { Inject, Injectable, Logger } from '@nestjs/common';
import { Money } from '../../common/money';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { ChartOfAccountsService } from '../ledger/chart-of-accounts.service';
import { LedgerService } from '../ledger/ledger.service';
import { EntryDirection, PostingAuthorization, TransactionType } from '../ledger/ledger.types';

/** Every wallet starts with an NGN account  */
export const HOME_CURRENCY = 'NGN';

/**
 * Creates wallets and their home-currency account, and posts the non-production demo
 * credit.
 */
@Injectable()
export class WalletProvisioningService {
  private readonly logger = new Logger(WalletProvisioningService.name);
  private readonly demoCreditMinor: bigint;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly chartOfAccounts: ChartOfAccountsService,
    private readonly ledger: LedgerService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.demoCreditMinor = config.authentication.demoCreditNgnMinor;
  }

  async openWallet(userId: string): Promise<{ walletId: string; accountId: string }> {
    const manager = this.unitOfWork.requireTransaction();
    const [wallet] = (await manager.query(`INSERT INTO wallets (user_id) VALUES ($1) RETURNING id`, [userId])) as {
      id: string;
    }[];
    const account = await this.chartOfAccounts.openUserAccount(wallet.id, HOME_CURRENCY);
    return { walletId: wallet.id, accountId: account.id };
  }

  
  async postDemoCreditIfEnabled(userId: string): Promise<void> {
    if (this.demoCreditMinor === 0n) return;
    const manager = this.unitOfWork.requireTransaction();
    const [account] = (await manager.query(
      `SELECT accounts.id FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id
        WHERE wallets.user_id = $1 AND accounts.currency_code = $2`,
      [userId, HOME_CURRENCY],
    )) as { id: string }[];
    const amount = Money.of(this.demoCreditMinor, HOME_CURRENCY);
    const posted = await this.ledger.post({
      transaction: {
        type: TransactionType.PROMOTIONAL,
        authorization: PostingAuthorization.SYSTEM_DRIVEN,
        valueTime: new Date(),
        initiatedBy: `user:${userId}`,
        reference: `demo-credit:${userId}`,
        userId,
        reasonCode: 'SIGNUP_DEMO_CREDIT',
      },
      entries: [
        { account: { systemAccount: 'EXPENSE:PROMOTIONAL' }, direction: EntryDirection.DEBIT, amount },
        { account: { accountId: account.id }, direction: EntryDirection.CREDIT, amount },
      ],
    });
    this.logger.log(
      { transactionId: posted.transactionId, reference: posted.reference, userId, amountMinor: amount.amountMinor.toString(), currency: HOME_CURRENCY },
      'Demo credit posted',
    );
  }
}
