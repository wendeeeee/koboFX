import { Module } from '@nestjs/common';
import { ClockModule } from '../../../common/clock';
import { AuditModule } from '../../audit/audit.module';
import { CurrenciesModule } from '../../currencies/currencies.module';
import { LedgerModule } from '../../ledger/ledger.module';
import { OutboxModule } from '../../outbox/outbox.module';
import { PaystackModule } from '../../payments/paystack/paystack.module';
import { WebhooksModule } from '../../payments/webhooks/webhooks.module';
import { UsersModule } from '../../users/users.module';
import { ReconciliationModule } from '../../reconciliation/reconciliation.module';
import { PaystackReconciliationJob } from '../../reconciliation/paystack-reconciliation.job';
import { FlowsModule } from '../flows.module';
import { PaystackFundingController } from './paystack-funding.controller';
import { PaystackFundingFlow } from './paystack-funding-flow';
import { PaystackFundingService } from './paystack-funding.service';
import { PaystackWebhookResolver } from './paystack-webhook-resolver';

export function isPaystackEnabled(env: Record<string, string | undefined>): boolean {
  return (env.PAYSTACK_ENABLED ?? '').trim().toLowerCase() === 'true';
}


@Module({
  imports: [
    FlowsModule,
    PaystackModule,
    WebhooksModule,
    LedgerModule,
    AuditModule,
    OutboxModule,
    UsersModule,
    CurrenciesModule,
    ClockModule,
    ReconciliationModule,
  ],
  controllers: [PaystackFundingController],
  providers: [PaystackFundingFlow, PaystackFundingService, PaystackWebhookResolver, PaystackReconciliationJob],
  exports: [PaystackFundingFlow, PaystackReconciliationJob],
})
export class PaystackFundingModule {}
