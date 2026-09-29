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
import { FundingNotFoundError } from './funding.errors';

/** `202` body of `POST /wallet/fund`: stored and replayed byte for byte by the idempotency barrier. */
export interface FundingAccepted {
  readonly fundingId: string;
  readonly status: 'PENDING';
  readonly amount: string;
  readonly currency: string;
}

/** `GET /wallet/fund/:fundingId`. */
export interface FundingView {
  readonly fundingId: string;
  readonly status: FundingStatus;
  readonly amount: string;
  readonly currency: string;
  readonly failureCode: string | null;
  readonly transactionReference: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Starts funding flows and reads them back (design §7.5, §12). Starting one is a
 * database-only unit — it runs inside the idempotency barrier's transaction, and the
 * PSP is only ever called by the worker, after this commits.
 */
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
  ) {}

  async start(userId: string, request: FundWalletDto): Promise<FundingAccepted> {
    const amount = fundingAmount(this.config.funding, request.amount, request.currency);
    this.currencies.require(amount.currency);
    return this.unitOfWork.run(async (manager) => {
      const [wallet] = (await manager.query(`SELECT id FROM wallets WHERE user_id = $1`, [userId])) as { id: string }[];
      if (!wallet) throw new InvariantViolationError('An active user has no wallet.', { userId });
      // Opening an account is not a balance change: it opens at zero (idempotent).
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

  /** Scoped by the caller in the WHERE clause: another user's funding is simply not found. */
  async find(userId: string, fundingId: string): Promise<FundingView> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT flow_instances.id, flow_instances.state, funding_payments.amount_minor::text AS amount_minor,
              funding_payments.currency_code, funding_payments.failure_code, transactions.reference,
              flow_instances.created_at, flow_instances.updated_at
         FROM flow_instances
         JOIN funding_payments ON funding_payments.flow_id = flow_instances.id
         LEFT JOIN transactions ON transactions.id = funding_payments.funding_transaction_id
        WHERE flow_instances.id = $1 AND flow_instances.user_id = $2 AND flow_instances.flow_type = 'FUNDING'`,
      [fundingId, userId],
    )) as {
      id: string;
      state: string;
      amount_minor: string;
      currency_code: string;
      failure_code: string | null;
      reference: string | null;
      created_at: Date;
      updated_at: Date;
    }[];
    if (!row) throw new FundingNotFoundError(fundingId);
    if (!isFundingState(row.state)) throw new InvariantViolationError(`Unknown funding state ${row.state}.`);
    return {
      fundingId: row.id,
      status: fundingStatusOf(row.state),
      amount: row.amount_minor,
      currency: row.currency_code,
      failureCode: row.failure_code,
      transactionReference: row.reference,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
}
