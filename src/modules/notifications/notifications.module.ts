import { Module, OnModuleInit } from '@nestjs/common';
import { OneTimePasswordsModule } from '../auth/one-time-passwords/one-time-passwords.module';
import { OutboxDispatcher } from '../outbox/outbox-dispatcher';
import { OutboxModule } from '../outbox/outbox.module';
import { UsersModule } from '../users/users.module';
import { EmailModule } from './email/email.module';
import {
  ConversionPostedHandler,
  EmailVerificationRequestedHandler,
  ExistingAccountRegistrationAttemptedHandler,
  FundingPostedHandler,
  TransactionPinChangedHandler,
  TransactionPinResetCodeRequestedHandler,
  WithdrawalCodeRequestedHandler,
} from './outbox-handlers';

@Module({
  imports: [OutboxModule, OneTimePasswordsModule, UsersModule, EmailModule],
  providers: [
    EmailVerificationRequestedHandler,
    ExistingAccountRegistrationAttemptedHandler,
    ConversionPostedHandler,
    FundingPostedHandler,
    WithdrawalCodeRequestedHandler,
    TransactionPinResetCodeRequestedHandler,
    TransactionPinChangedHandler,
  ],
})
export class NotificationsModule implements OnModuleInit {
  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly emailVerification: EmailVerificationRequestedHandler,
    private readonly existingAccount: ExistingAccountRegistrationAttemptedHandler,
    private readonly conversionPosted: ConversionPostedHandler,
    private readonly fundingPosted: FundingPostedHandler,
    private readonly withdrawalCode: WithdrawalCodeRequestedHandler,
    private readonly pinResetCode: TransactionPinResetCodeRequestedHandler,
    private readonly pinChanged: TransactionPinChangedHandler,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this.emailVerification);
    this.dispatcher.register(this.existingAccount);
    this.dispatcher.register(this.conversionPosted);
    this.dispatcher.register(this.fundingPosted);
    this.dispatcher.register(this.withdrawalCode);
    this.dispatcher.register(this.pinResetCode);
    this.dispatcher.register(this.pinChanged);
  }
}
