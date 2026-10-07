import { DynamicModule, Inject, Injectable, Logger, Module, OnApplicationBootstrap, OnModuleInit, Provider } from '@nestjs/common';
import { DependencyUnavailableError, InvariantViolationError } from '../../common/errors';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { AuditModule } from '../audit/audit.module';
import { OneTimePasswordsModule } from '../auth/one-time-passwords/one-time-passwords.module';
import { FlowsModule } from '../flows/flows.module';
import { LedgerModule } from '../ledger/ledger.module';
import { OutboxDispatcher } from '../outbox/outbox-dispatcher';
import { OutboxModule } from '../outbox/outbox.module';
import { ClaimedOutboxEvent, OutboxEventHandler, OutboxEventType } from '../outbox/outbox.types';
import { PaystackModule } from '../payments/paystack/paystack.module';
import { PaystackTransfersModule } from '../payments/paystack/transfers/paystack-transfers.module';
import { WebhooksModule } from '../payments/webhooks/webhooks.module';
import { PaystackTransferReconciliation } from '../reconciliation/paystack/paystack-transfer-reconciliation';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { PaystackTransfersGateway } from '../payments/paystack/transfers/paystack-transfers.port';
import { ProtectionModule } from '../protection/protection.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { UsersModule } from '../users/users.module';
import { BankDirectoryService } from './bank-directory.service';
import { BeneficiaryFlow } from './beneficiary-flow';
import { BeneficiaryService } from './beneficiary.service';
import { WithdrawalAdmissionGate, WithdrawalWorkerHeartbeat } from './withdrawal-admission-gate';
import { ProtectedHoldMetrics, ProtectedHoldMonitor } from './protected-hold-monitor';
import { WithdrawalFlow } from './withdrawal-flow';
import { WithdrawalTrail } from './withdrawal-records';
import { WithdrawalCodeService } from './withdrawal-code.service';
import { WithdrawalService } from './withdrawal.service';
import { WithdrawalsController } from './withdrawals.controller';

/** Recorded withdrawal work is processed whenever a Paystack key is configured — whatever the admission switch says. */
export function hasPaystackKey(env: Record<string, string | undefined>): boolean {
  return (env.PAYSTACK_SECRET_KEY ?? '').trim().length > 0;
}

/** Acknowledges the withdrawal events (no customer notification is in scope); a malformed payload fails loudly. */
@Injectable()
export class WithdrawalEventsHandler implements OutboxEventHandler {
  private readonly logger = new Logger(WithdrawalEventsHandler.name);

  constructor(readonly eventType: OutboxEventType) {}

  async handle(event: ClaimedOutboxEvent): Promise<void> {
    const payload = event.payload as { flowId?: unknown; userId?: unknown; state?: unknown };
    const id = /^[0-9a-f-]{36}$/;
    if (typeof payload.flowId !== 'string' || !id.test(payload.flowId) || typeof payload.userId !== 'string' || !id.test(payload.userId) ||
        typeof payload.state !== 'string' || !/^[A-Z_]{1,32}$/.test(payload.state)) {
      throw new InvariantViolationError(`Outbox event ${event.id} has a malformed payload.`);
    }
    this.logger.log({ eventId: event.id, eventType: this.eventType, flowId: payload.flowId, state: payload.state }, 'Withdrawal event acknowledged');
  }
}

/** `ProtectedHoldFlagged.v1` → acknowledged (paging is the audit row, the log and the metric). Malformed fails loudly. */
@Injectable()
export class ProtectedHoldFlaggedHandler implements OutboxEventHandler {
  readonly eventType = OutboxEventType.PROTECTED_HOLD_FLAGGED;
  private readonly logger = new Logger(ProtectedHoldFlaggedHandler.name);

  async handle(event: ClaimedOutboxEvent): Promise<void> {
    const payload = event.payload as { reservationId?: unknown; flowId?: unknown; condition?: unknown };
    const id = /^[0-9a-f-]{36}$/;
    if (typeof payload.reservationId !== 'string' || !id.test(payload.reservationId) || typeof payload.flowId !== 'string' || !id.test(payload.flowId) ||
        typeof payload.condition !== 'string' || !/^[A-Z_]{1,32}$/.test(payload.condition)) {
      throw new InvariantViolationError(`Outbox event ${event.id} has a malformed payload.`);
    }
    this.logger.warn({ eventId: event.id, flowId: payload.flowId, condition: payload.condition }, 'Protected hold flag acknowledged');
  }
}

/** Without a Paystack key the API still serves reads; anything that would call Paystack fails as a dependency. */
class UnconfiguredTransfersGateway extends PaystackTransfersGateway {
  private refuse(): never {
    throw new DependencyUnavailableError('Paystack transfers need PAYSTACK_SECRET_KEY, which is not configured.', { dependency: 'paystack' });
  }
  listBanks = (): never => this.refuse();
  resolveAccount = (): never => this.refuse();
  createRecipient = (): never => this.refuse();
  listRecipients = (): never => this.refuse();
  fetchRecipient = (): never => this.refuse();
  initiateTransfer = (): never => this.refuse();
  verifyTransfer = (): never => this.refuse();
  fetchTransfer = (): never => this.refuse();
  listTransfers = (): never => this.refuse();
  balances = (): never => this.refuse();
  balanceLedger = (): never => this.refuse();
}

/**
 * Worker boot check (WITHDRAWAL_PLAN.md §K): recorded withdrawal work needs the key, the key rings and the account
 * identity to be processed. Missing any of them with work recorded is a visible startup failure — never a worker that
 * silently leaves payouts unverified.
 */
@Injectable()
export class WithdrawalRecoveryBootCheck implements OnApplicationBootstrap {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT count(*)::int AS count FROM flow_instances
        WHERE flow_type IN ('PAYSTACK_WITHDRAWAL', 'PAYSTACK_BENEFICIARY') AND (completed_at IS NULL OR state = 'POSTED')`,
    )) as { count: number }[];
    if (row.count === 0) return;
    const protection = this.config.protection;
    const missing = [
      ...(this.config.paystack.secretKey ? [] : ['PAYSTACK_SECRET_KEY']),
      ...(protection.keyEncryption ? [] : ['WITHDRAWAL_KEY_ENCRYPTION_KEYS']),
      ...(protection.fingerprint ? [] : ['WITHDRAWAL_FINGERPRINT_KEYS']),
    ];
    if (missing.length > 0) {
      throw new InvariantViolationError(`${row.count} recorded withdrawal flow(s) need ${missing.join(', ')} to be processed; refusing to start.`);
    }
  }
}

@Module({})
export class WithdrawalsModule implements OnModuleInit {
  constructor(
    private readonly dispatcher: OutboxDispatcher,
    @Inject('WITHDRAWAL_EVENT_HANDLERS') private readonly handlers: OutboxEventHandler[],
  ) {}

  onModuleInit(): void {
    for (const handler of this.handlers) this.dispatcher.register(handler);
  }

  /**
   * Routes, reads and admission are always present (admission refuses while switched off). With a Paystack key the
   * transfers gateway, the TRANSFER webhook family, both flow definitions and the worker heartbeat come along, so
   * accepted work keeps moving even when new admissions are off. `worker: true` adds the boot check.
   */
  static forRoot(env: Record<string, string | undefined>, options: { worker?: boolean } = {}): DynamicModule {
    const keyed = hasPaystackKey(env);
    const providers: Provider[] = [
      BankDirectoryService,
      BeneficiaryService,
      WithdrawalService,
      WithdrawalCodeService,
      WithdrawalAdmissionGate,
      WithdrawalTrail,
      ProtectedHoldMetrics,
      ProtectedHoldMonitor,
      {
        provide: 'WITHDRAWAL_EVENT_HANDLERS',
        useValue: [
          new WithdrawalEventsHandler(OutboxEventType.BENEFICIARY_CHANGED),
          new WithdrawalEventsHandler(OutboxEventType.WITHDRAWAL_CHANGED),
          new ProtectedHoldFlaggedHandler(),
        ],
      },
      ...(keyed
        ? [BeneficiaryFlow, WithdrawalFlow, WithdrawalWorkerHeartbeat, PaystackTransferReconciliation]
        : [{ provide: PaystackTransfersGateway, useClass: UnconfiguredTransfersGateway }]),
      ...(options.worker ? [WithdrawalRecoveryBootCheck] : []),
    ];
    return {
      module: WithdrawalsModule,
      imports: [
        FlowsModule,
        LedgerModule,
        ReservationsModule,
        ProtectionModule,
        AuditModule,
        OutboxModule,
        UsersModule,
        OneTimePasswordsModule,
        // With a key: the transfers boundary, and the TRANSFER component of THE Paystack reconciliation (W4).
        ...(keyed ? [PaystackTransfersModule, PaystackModule, ReconciliationModule, WebhooksModule] : []),
      ],
      controllers: [WithdrawalsController],
      providers,
      exports: [WithdrawalAdmissionGate, ProtectedHoldMonitor, ProtectedHoldMetrics, ...(keyed ? [WithdrawalWorkerHeartbeat, WithdrawalFlow] : [])],
    };
  }
}
