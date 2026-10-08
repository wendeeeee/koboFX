import { Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { InvariantViolationError } from '../../common/errors';
import { AuditModule } from '../audit/audit.module';
import { FlowsModule } from '../flows/flows.module';
import { LedgerModule } from '../ledger/ledger.module';
import { OutboxDispatcher } from '../outbox/outbox-dispatcher';
import { OutboxModule } from '../outbox/outbox.module';
import { ClaimedOutboxEvent, OutboxEventHandler, OutboxEventType, ReconciliationBreakChangedPayload } from '../outbox/outbox.types';
import { PaymentsModule } from '../payments/payments.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { BreakService } from './break.service';
import { ExternalReconciliationJob } from './external-reconciliation.job';
import { InternalReconciliationJob } from './internal-reconciliation.job';
import { ReconciliationCheckpoints } from './reconciliation-checkpoints';
import { ReconciliationMetrics } from './reconciliation-metrics';
import { ReconciliationRunRepository } from './reconciliation-run.repository';
import { ReconciliationScheduler } from './reconciliation-scheduler';
import { SettlementIngestionService } from './settlement-ingestion.service';
import { BreakOwnership, ProviderReconciliationRegistry } from './provider-reconciliation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `ReconciliationBreakChanged.v1` → acknowledged. Phase 10's admin (and alert routing) consume
 * it; registered now so the dispatcher never dead-letters an unknown type. Idempotent.
 */
@Injectable()
export class ReconciliationBreakChangedHandler implements OutboxEventHandler {
  readonly eventType = OutboxEventType.RECONCILIATION_BREAK_CHANGED;
  private readonly logger = new Logger(ReconciliationBreakChangedHandler.name);

  async handle(event: ClaimedOutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as Partial<ReconciliationBreakChangedPayload>;
    if (typeof payload.breakId !== 'string' || !UUID.test(payload.breakId) || payload.breakId !== event.aggregateId) {
      throw new InvariantViolationError(`Outbox event ${event.id} has a malformed payload.`);
    }
    this.logger.log({ eventId: event.id, breakId: payload.breakId, breakType: payload.type, status: payload.status }, 'Reconciliation break change: acknowledged');
  }
}

/**
 * Reconciliation (design §8, §14 `reconciliation/`; Phase 9): internal checks, settlement
 * ingestion and posting, external matching, breaks, and the worker's scheduler.
 */
@Module({
  imports: [LedgerModule, ReservationsModule, FlowsModule, PaymentsModule, AuditModule, OutboxModule],
  providers: [
    ReconciliationRunRepository,
    ReconciliationCheckpoints,
    ReconciliationMetrics,
    BreakService,
    InternalReconciliationJob,
    SettlementIngestionService,
    ExternalReconciliationJob,
    ReconciliationScheduler,
    ReconciliationBreakChangedHandler,
    ProviderReconciliationRegistry,
    BreakOwnership,
  ],
  exports: [
    ReconciliationRunRepository,
    ReconciliationCheckpoints,
    ReconciliationMetrics,
    BreakService,
    InternalReconciliationJob,
    SettlementIngestionService,
    ExternalReconciliationJob,
    ReconciliationScheduler,
    ProviderReconciliationRegistry,
    BreakOwnership,
  ],
})
export class ReconciliationModule implements OnModuleInit {
  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly breakChanged: ReconciliationBreakChangedHandler,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this.breakChanged);
  }
}
