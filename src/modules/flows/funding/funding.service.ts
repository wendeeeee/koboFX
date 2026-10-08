import { Inject, Injectable } from '@nestjs/common';
import { InvariantViolationError } from '../../../common/errors';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { AuditAction, AuditLogService, AuditSubjectType } from '../../audit/audit-log.service';
import { CurrencyRegistry } from '../../currencies/currency-registry';
import { ChartOfAccountsService } from '../../ledger/chart-of-accounts.service';
import { PaymentProvider } from '../../payments/payment-provider.port';
import { FlowRepository } from '../flow.repository';
import { FlowType } from '../flow.types';
import { FundWalletDto } from './dto/fund-wallet.dto';
import { FundingPaymentRepository } from './funding-payment.repository';
import { fundingAmount } from './funding-limits';
import { FundingState, FundingStatus, fundingStatusOf, isFundingState } from './funding-transitions';
import { isPaystackFundingState, paystackFundingStatusOf } from '../paystack-funding/paystack-funding-transitions';
import { Clock } from '../../../common/clock';
import { FundingNotFoundError } from './funding.errors';


export interface FundingAccepted {
  readonly fundingId: string;
  readonly status: 'PENDING';
  readonly amount: string;
  readonly currency: string;
}

export interface FundingCheckoutView {
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}


export interface FundingView {
  readonly fundingId: string;
  readonly status: FundingStatus;
  readonly amount: string;
  readonly currency: string;
  readonly provider: 'simulated' | 'paystack';
  readonly checkout: FundingCheckoutView | null;
  readonly failureCode: string | null;
  readonly transactionReference: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

@Injectable()
export class FundingService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly flows: FlowRepository,
    private readonly payments: FundingPaymentRepository,
    private readonly chartOfAccounts: ChartOfAccountsService,
    private readonly currencies: CurrencyRegistry,
    private readonly audit: AuditLogService,
    private readonly provider: PaymentProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  async start(userId: string, request: FundWalletDto): Promise<FundingAccepted> {
    const amount = fundingAmount(this.config.funding, request.amount, request.currency);
    this.currencies.require(amount.currency);
    return this.unitOfWork.run(async (manager) => {
      const [wallet] = (await manager.query(`SELECT id FROM wallets WHERE user_id = $1`, [userId])) as { id: string }[];
      if (!wallet) throw new InvariantViolationError('An active user has no wallet.', { userId });
      const account = await this.chartOfAccounts.openUserAccount(wallet.id, amount.currency);
      const flow = await this.flows.create(FlowType.FUNDING, userId, FundingState.INITIATED);
      await this.payments.insert({
        flowId: flow.id,
        userId,
        accountId: account.id,
        amount,
        provider: this.provider.name,
        paymentMethodToken: request.paymentMethodToken,
      });
      await this.audit.record({
        actor: { type: 'USER', id: userId },
        action: AuditAction.FUNDING_INITIATED,
        subject: { type: AuditSubjectType.FLOW, id: flow.id },
        after: { flowState: FundingState.INITIATED },
        reason: 'user requested a wallet funding',
      });
      return { fundingId: flow.id, status: 'PENDING', amount: amount.toMinorString(), currency: amount.currency };
    });
  }

  async find(userId: string, fundingId: string): Promise<FundingView> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT flow_instances.id, flow_instances.flow_type, flow_instances.state,
              funding_payments.amount_minor::text AS amount_minor, funding_payments.currency_code,
              funding_payments.failure_code, transactions.reference, funding_payments.checkout_authorization_url,
              funding_payments.checkout_expires_at, flow_instances.created_at, flow_instances.updated_at
         FROM flow_instances
         JOIN funding_payments ON funding_payments.flow_id = flow_instances.id
         LEFT JOIN transactions ON transactions.id = funding_payments.funding_transaction_id
        WHERE flow_instances.id = $1 AND flow_instances.user_id = $2
          AND flow_instances.flow_type IN ('FUNDING', 'PAYSTACK_FUNDING')`,
      [fundingId, userId],
    )) as {
      id: string;
      flow_type: string;
      state: string;
      checkout_authorization_url: string | null;
      checkout_expires_at: Date | null;
      amount_minor: string;
      currency_code: string;
      failure_code: string | null;
      reference: string | null;
      created_at: Date;
      updated_at: Date;
    }[];
    if (!row) throw new FundingNotFoundError(fundingId);
    const paystack = row.flow_type === 'PAYSTACK_FUNDING';
    let status: FundingStatus;
    if (paystack && isPaystackFundingState(row.state)) status = paystackFundingStatusOf(row.state);
    else if (!paystack && isFundingState(row.state)) status = fundingStatusOf(row.state);
    else throw new InvariantViolationError(`Unknown funding state ${row.state}.`);
    const checkoutOpen =
      paystack && row.state === 'CHECKOUT_READY' && row.checkout_authorization_url !== null && row.checkout_expires_at !== null &&
      row.checkout_expires_at.getTime() > this.clock.now().getTime();
    return {
      fundingId: row.id,
      status,
      amount: row.amount_minor,
      currency: row.currency_code,
      provider: paystack ? 'paystack' : 'simulated',
      checkout: checkoutOpen
        ? { authorizationUrl: row.checkout_authorization_url as string, expiresAt: (row.checkout_expires_at as Date).toISOString() }
        : null,
      failureCode: row.failure_code,
      transactionReference: row.reference,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
}
