import { Inject, Injectable } from '@nestjs/common';
import { InvariantViolationError } from '../../../common/errors';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { AuditAction, AuditLogService, AuditSubjectType } from '../../audit/audit-log.service';
import { CurrencyRegistry } from '../../currencies/currency-registry';
import { ChartOfAccountsService } from '../../ledger/chart-of-accounts.service';
import { FlowRepository } from '../flow.repository';
import { FlowType } from '../flow.types';
import { FundingPaymentRepository } from '../funding/funding-payment.repository';
import { fundingAmount } from '../funding/funding-limits';
import { PaystackFundWalletDto } from './dto/paystack-fund-wallet.dto';
import { PaystackFundingState } from './paystack-funding-transitions';


export interface PaystackFundingAccepted {
  readonly fundingId: string;
  readonly status: 'PENDING';
  readonly amount: string;
  readonly currency: string;
  readonly provider: 'paystack';
}


@Injectable()
export class PaystackFundingService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly flows: FlowRepository,
    private readonly payments: FundingPaymentRepository,
    private readonly chartOfAccounts: ChartOfAccountsService,
    private readonly currencies: CurrencyRegistry,
    private readonly audit: AuditLogService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async start(userId: string, request: PaystackFundWalletDto): Promise<PaystackFundingAccepted> {
    const amount = fundingAmount(this.config.funding, request.amount, request.currency, this.config.paystack.currencies);
    this.currencies.require(amount.currency);
    return this.unitOfWork.run(async (manager) => {
      const [wallet] = (await manager.query(`SELECT id FROM wallets WHERE user_id = $1`, [userId])) as { id: string }[];
      if (!wallet) throw new InvariantViolationError('An active user has no wallet.', { userId });
      const account = await this.chartOfAccounts.openUserAccount(wallet.id, amount.currency);
      const flow = await this.flows.create(FlowType.PAYSTACK_FUNDING, userId, PaystackFundingState.INITIATED);
      await this.payments.insert({
        flowId: flow.id,
        userId,
        accountId: account.id,
        amount,
        provider: this.config.paystack.name,
        paymentMethodToken: null,
      });
      await this.audit.record({
        actor: { type: 'USER', id: userId },
        action: AuditAction.FUNDING_INITIATED,
        subject: { type: AuditSubjectType.FLOW, id: flow.id },
        after: { flowState: PaystackFundingState.INITIATED },
        reason: 'user requested a Paystack wallet funding',
      });
      return { fundingId: flow.id, status: 'PENDING', amount: amount.toMinorString(), currency: amount.currency, provider: 'paystack' };
    });
  }
}
