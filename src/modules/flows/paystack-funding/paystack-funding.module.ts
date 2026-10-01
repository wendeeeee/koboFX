import { Module } from '@nestjs/common';
import { ClockModule } from '../../../common/clock';
import { AuditModule } from '../../audit/audit.module';
import { CurrenciesModule } from '../../currencies/currencies.module';
import { LedgerModule } from '../../ledger/ledger.module';
import { OutboxModule } from '../../outbox/outbox.module';
import { PaystackModule } from '../../payments/paystack/paystack.module';
import { WebhooksModule } from '../../payments/webhooks/webhooks.module';
import { UsersModule } from '../../users/users.module';
import { FlowsModule } from '../flows.module';
import { PaystackFundingController } from './paystack-funding.controller';
import { PaystackFundingFlow } from './paystack-funding-flow';
import { PaystackFundingService } from './paystack-funding.service';
import { PaystackWebhookResolver } from './paystack-webhook-resolver';

/** `PAYSTACK_ENABLED` as the config loader reads it (Joi boolean: case-insensitive "true"). */
export function isPaystackEnabled(env: Record<string, string | undefined>): boolean {
  return (env.PAYSTACK_ENABLED ?? '').trim().toLowerCase() === 'true';
}

/**
 * Paystack funding (PAYSTACK_PLAN.md): the flow (registered with the shared runner and resumer), the start service
 * and route, and the webhook resolver. Imported by the API and the worker ONLY when `PAYSTACK_ENABLED=true`.
 */
@Module({
  imports: [FlowsModule, PaystackModule, WebhooksModule, LedgerModule, AuditModule, OutboxModule, UsersModule, CurrenciesModule, ClockModule],
  controllers: [PaystackFundingController],
  providers: [PaystackFundingFlow, PaystackFundingService, PaystackWebhookResolver],
  exports: [PaystackFundingFlow],
})
export class PaystackFundingModule {}
