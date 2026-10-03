import { Inject, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Clock } from '../../common/clock';
import { DomainError, InvariantViolationError } from '../../common/errors';
import { Dec, Money } from '../../common/money';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { AuditAction, AuditLogService, AuditSubjectType } from '../audit/audit-log.service';
import { AccountSuspendedError, EmailNotVerifiedError } from '../auth/auth.errors';
import { FlowRepository } from '../flows/flow.repository';
import { FlowType } from '../flows/flow.types';
import { PricedCurrency, QuoteAmountMode, exactRateString } from '../fx/pricing';
import { ChartOfAccountsService } from '../ledger/chart-of-accounts.service';
import { LedgerService } from '../ledger/ledger.service';
import { TransactionType } from '../ledger/ledger.types';
import { OutboxService } from '../outbox/outbox.service';
import { ConversionPostedPayload, OutboxEventType } from '../outbox/outbox.types';
import { ReservationService } from '../reservations/reservation.service';
import { UserStatus } from '../users/user.types';
import { assertWithinConversionMaximum, assertWithinDailyLimit } from './conversion-limits';
import { ConversionAmounts, assertConversionAmounts, assertRateDisplayReproduces, conversionEntries, rateDisplayOf } from './conversion-posting';
import { ConversionState, assertConversionTransition } from './conversion-transitions';
import { ConversionView, conversionView } from './conversion.view';
import { TradingMetrics } from './trading-metrics';

export enum ConversionReason {
  MARKET_CONVERSION = 'MARKET_CONVERSION',
  QUOTED_TRADE = 'QUOTED_TRADE',
}


export interface ConversionOrder {
  readonly source: PricedCurrency;
  readonly target: PricedCurrency;
  readonly amountMode: QuoteAmountMode;
  readonly amounts: ConversionAmounts;
  readonly midRate: Dec;
  readonly clientRate: Dec;
  readonly spreadBasisPoints: number;
  readonly rateSnapshotId: string;
  readonly rateProvider: string;
  readonly rateProviderUpdatedAt: Date;
  readonly rateFetchedAt: Date;
  readonly quoteId?: string;
  readonly reason: ConversionReason;
}


const RESERVATION_SAFETY_NET_MILLISECONDS = 5 * 60_000;


@Injectable()
export class ConversionService {
  private readonly logger = new Logger(ConversionService.name);

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ledger: LedgerService,
    private readonly chartOfAccounts: ChartOfAccountsService,
    private readonly reservations: ReservationService,
    private readonly flows: FlowRepository,
    private readonly outbox: OutboxService,
    private readonly audit: AuditLogService,
    private readonly metrics: TradingMetrics,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

 
  async execute(
    userId: string,
    idempotencyKey: string | undefined,
    pair: { from: string; to: string },
    loadOrder: () => Promise<ConversionOrder>,
  ): Promise<ConversionView> {
    try {
      const view = await this.unitOfWork.run((manager) => this.executeInTransaction(manager, userId, idempotencyKey, loadOrder));
      this.metrics.recordConversion(view.debited.currency, view.credited.currency, 'POSTED');
      return view;
    } catch (error) {
      this.metrics.recordConversion(pair.from, pair.to, error instanceof DomainError ? error.code : 'ERROR');
      throw error;
    }
  }

  private async executeInTransaction(
    manager: EntityManager,
    userId: string,
    idempotencyKey: string | undefined,
    loadOrder: () => Promise<ConversionOrder>,
  ): Promise<ConversionView> {
    await this.lockUserForShare(manager, userId);
    const order = await loadOrder();
    const { source, target, amounts } = order;

    assertWithinConversionMaximum(this.config.conversion, source.code, amounts);
    assertConversionAmounts(amounts);
    const rateDisplay = rateDisplayOf(source, amounts.sourceAmountMinor, target, amounts.targetAmountMinor);
    assertRateDisplayReproduces(rateDisplay, source, amounts.sourceAmountMinor, target, amounts.targetAmountMinor);

    const [wallet] = (await manager.query(`SELECT id FROM wallets WHERE user_id = $1`, [userId])) as { id: string }[];
    if (!wallet) throw new InvariantViolationError('An active user has no wallet.', { userId });
 
    const opened = new Map<string, { id: string }>();
    for (const code of [source.code, target.code].sort()) opened.set(code, await this.chartOfAccounts.openUserAccount(wallet.id, code));
    const sourceAccount = opened.get(source.code) as { id: string };
    const targetAccount = opened.get(target.code) as { id: string };
    await this.ledger.lockUserAccounts([sourceAccount.id, targetAccount.id]);

    assertWithinDailyLimit(
      this.config.conversion,
      source.code,
      await this.convertedInWindow(manager, userId, source.code),
      amounts.sourceAmountMinor,
    );

    const flow = await this.flows.create(FlowType.CONVERSION, userId, ConversionState.INITIATED);
    const reservation = await this.reservations.reserve({
      accountId: sourceAccount.id,
      flowId: flow.id,
      amount: Money.of(amounts.sourceAmountMinor, source.code),
      expiresAt: new Date(Date.now() + RESERVATION_SAFETY_NET_MILLISECONDS),
    });

 
    const [{ now: valueTime }] = (await manager.query(`SELECT now() AS now`)) as { now: Date }[];
    const reference = `conversion:${flow.id}`;
    const settled = await this.reservations.settle(reservation.id, {
      transaction: {
        type: TransactionType.CONVERSION,
        valueTime,
        initiatedBy: `user:${userId}`,
        userId,
        reference,
        reasonCode: order.reason,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        metadata: { flowId: flow.id, amountMode: order.amountMode },
        conversion: {
          sourceCurrency: source.code,
          sourceAmountMinor: amounts.sourceAmountMinor,
          targetCurrency: target.code,
          targetAmountMinor: amounts.targetAmountMinor,
          rateDisplay,
          referenceRate: exactRateString(order.midRate),
          rateProvider: order.rateProvider,
          rateFetchedAt: order.rateFetchedAt,
          rateProviderUpdatedAt: order.rateProviderUpdatedAt,
          rateSnapshotId: order.rateSnapshotId,
          spreadBasisPoints: order.spreadBasisPoints,
          ...(order.quoteId ? { quoteId: order.quoteId } : {}),
        },
      },
      entries: conversionEntries({
        source,
        target,
        sourceAccountId: sourceAccount.id,
        targetAccountId: targetAccount.id,
        amounts,
      }),
    });
    const transactionId = settled.settlementTransactionId;
    if (!transactionId) throw new InvariantViolationError('A settled conversion has no transaction.', { reservationId: reservation.id });
    const [{ booking_time: bookingTime }] = (await manager.query(`SELECT booking_time FROM transactions WHERE id = $1`, [
      transactionId,
    ])) as { booking_time: Date }[];

    assertConversionTransition(ConversionState.INITIATED, ConversionState.POSTED);
    await this.flows.completeSynchronous(flow.id, ConversionState.INITIATED, ConversionState.POSTED);

    const payload: ConversionPostedPayload = { transactionId, userId, flowId: flow.id, quoteId: order.quoteId ?? null };
    await this.outbox.enqueue(OutboxEventType.CONVERSION_POSTED, transactionId, payload);
    await this.audit.record({
      actor: { type: 'USER', id: userId },
      action: AuditAction.CONVERSION_POSTED,
      subject: { type: AuditSubjectType.FLOW, id: flow.id },
      after: { flowState: ConversionState.POSTED, transactionId },
      reason: order.reason === ConversionReason.QUOTED_TRADE ? 'user executed a quote' : 'user converted at the market rate',
    });

    this.logger.log(
      {
        transactionId,
        reference,
        userId,
        type: TransactionType.CONVERSION,
        sourceCurrency: source.code,
        sourceAmountMinor: amounts.sourceAmountMinor.toString(),
        targetCurrency: target.code,
        targetAmountMinor: amounts.targetAmountMinor.toString(),
        revenueMinor: amounts.revenueMinor.toString(),
        quoteId: order.quoteId ?? null,
        rateProvider: order.rateProvider,
        rateSnapshotId: order.rateSnapshotId,
        rateAgeMilliseconds: this.clock.now().getTime() - order.rateProviderUpdatedAt.getTime(),
        initiatedBy: `user:${userId}`,
      },
      'Conversion posted',
    );

    return conversionView({
      transactionId,
      reference,
      quoteId: order.quoteId ?? null,
      amountMode: order.amountMode,
      source,
      target,
      sourceAmountMinor: amounts.sourceAmountMinor,
      targetAmountMinor: amounts.targetAmountMinor,
      rateDisplay,
      clientRate: order.clientRate,
      midRate: order.midRate,
      spreadBasisPoints: order.spreadBasisPoints,
      rateProvider: order.rateProvider,
      rateProviderUpdatedAt: order.rateProviderUpdatedAt,
      rateFetchedAt: order.rateFetchedAt,
      rateSnapshotId: order.rateSnapshotId,
      valueTime,
      bookingTime,
    });
  }

 
  private async lockUserForShare(manager: EntityManager, userId: string): Promise<void> {
    const [user] = (await manager.query(`SELECT status FROM users WHERE id = $1 FOR SHARE`, [userId])) as { status: UserStatus }[];
    if (!user) throw new InvariantViolationError('An authenticated user does not exist.', { userId });
    if (user.status === UserStatus.SUSPENDED) throw new AccountSuspendedError();
    if (user.status !== UserStatus.ACTIVE) throw new EmailNotVerifiedError();
  }

 
  private async convertedInWindow(manager: EntityManager, userId: string, sourceCurrency: string): Promise<bigint> {
    const [row] = (await manager.query(
      `SELECT coalesce(sum(source_amount_minor), 0)::text AS total
         FROM transactions
        WHERE user_id = $1 AND type = 'CONVERSION' AND status = 'POSTED'
          AND source_currency = $2 AND booking_time > now() - interval '24 hours'`,
      [userId, sourceCurrency],
    )) as { total: string }[];
    return BigInt(row.total);
  }
}
