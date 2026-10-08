import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PaymentsModule } from '../payments/payments.module';
import { UsersModule } from '../users/users.module';
import { FlowCheckpoints } from './flow-checkpoints';
import { FlowMetrics } from './flow-metrics';
import { FlowResumer } from './flow-resumer';
import { FlowRunner } from './flow-runner';
import { FlowRepository } from './flow.repository';
import { FundingFlow } from './funding/funding-flow';
import { FundingPaymentRepository } from './funding/funding-payment.repository';
import { FundingService } from './funding/funding.service';


@Module({
  imports: [PaymentsModule, LedgerModule, AuditModule, UsersModule],
  providers: [
    FlowRepository,
    FlowCheckpoints,
    FlowRunner,
    FlowResumer,
    FlowMetrics,
    FundingPaymentRepository,
    FundingFlow,
    FundingService,
  ],
  exports: [FlowRepository, FlowCheckpoints, FlowRunner, FlowResumer, FlowMetrics, FundingPaymentRepository, FundingService],
})
export class FlowsModule {}
