import { Module, OnModuleInit } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { FlowsModule } from '../flows/flows.module';
import { FxModule } from '../fx/fx.module';
import { LedgerModule } from '../ledger/ledger.module';
import { OutboxDispatcher } from '../outbox/outbox-dispatcher';
import { OutboxModule } from '../outbox/outbox.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { ApprovalChangedHandler, BreakGlassReviewOverdueHandler, BreakGlassUsedHandler, ExchangeRateOverriddenHandler } from './admin-event-handlers';
import { AdminMetrics } from './admin-metrics';
import { ACTION_EXECUTORS, ActionExecutor } from './actions/action-registry';
import { CorrectionExecutor } from './actions/correction.executor';
import { PeriodCloseExecutor } from './actions/period-close.executor';
import { RateOverrideExecutor } from './actions/rate-override.executor';
import { ResolveBreakExecutor } from './actions/resolve-break.executor';
import { RoleChangeExecutor } from './actions/role-change.executor';
import { SpreadChangeExecutor } from './actions/spread-change.executor';
import { PaystackWithdrawalRecoveryExecutor } from './actions/paystack-withdrawal-recovery.executor';
import { ReinstateUserExecutor, SuspendUserExecutor } from './actions/user-status.executor';
import { WriteOffExecutor } from './actions/write-off.executor';
import { ApprovalRepository } from './approvals/approval.repository';
import { ApprovalService } from './approvals/approval.service';
import { ApprovalsController } from './approvals/approvals.controller';
import { AdminMonitor } from './break-glass/admin-monitor';
import { PositionsService } from './positions/positions.service';
import { AdminReadsController } from './reads/admin-reads.controller';
import { AdminReadsService } from './reads/admin-reads.service';
import { AuditTrailReader } from './reads/audit-trail.reader';

const EXECUTORS = [
  CorrectionExecutor,
  WriteOffExecutor,
  RateOverrideExecutor,
  SpreadChangeExecutor,
  SuspendUserExecutor,
  ReinstateUserExecutor,
  PeriodCloseExecutor,
  RoleChangeExecutor,
  ResolveBreakExecutor,
  PaystackWithdrawalRecoveryExecutor,
];

/**
 * Controls (design §9, §12, §14 `admin/`; Phase 10): RBAC'd admin routes, approvals and four-eyes, break-glass,
 * the action executors, positions, the admin reads and recertification. In the API AND the worker: the worker
 * runs the monitor loop and dispatches the outbox events this module registers handlers for.
 */
@Module({
  imports: [LedgerModule, ReconciliationModule, FlowsModule, FxModule, AuthModule, TransactionsModule, AuditModule, OutboxModule],
  controllers: [ApprovalsController, AdminReadsController],
  providers: [
    ApprovalRepository,
    ApprovalService,
    AdminMetrics,
    AuditTrailReader,
    AdminReadsService,
    PositionsService,
    AdminMonitor,
    ...EXECUTORS,
    {
      provide: ACTION_EXECUTORS,
      inject: EXECUTORS,
      useFactory: (...executors: ActionExecutor[]) => executors,
    },
    ApprovalChangedHandler,
    BreakGlassUsedHandler,
    BreakGlassReviewOverdueHandler,
    ExchangeRateOverriddenHandler,
  ],
  exports: [ApprovalService, ApprovalRepository, AdminMetrics, AdminMonitor, AdminReadsService, PositionsService],
})
export class AdminModule implements OnModuleInit {
  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly approvalChanged: ApprovalChangedHandler,
    private readonly breakGlassUsed: BreakGlassUsedHandler,
    private readonly breakGlassOverdue: BreakGlassReviewOverdueHandler,
    private readonly rateOverridden: ExchangeRateOverriddenHandler,
  ) {}

  onModuleInit(): void {
    for (const handler of [this.approvalChanged, this.breakGlassUsed, this.breakGlassOverdue, this.rateOverridden]) this.dispatcher.register(handler);
  }
}
