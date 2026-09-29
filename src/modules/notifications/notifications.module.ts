import { Module, OnModuleInit } from '@nestjs/common';
import { OneTimePasswordsModule } from '../auth/one-time-passwords/one-time-passwords.module';
import { OutboxDispatcher } from '../outbox/outbox-dispatcher';
import { OutboxModule } from '../outbox/outbox.module';
import { UsersModule } from '../users/users.module';
import { EmailModule } from './email/email.module';
import { ConversionPostedHandler, EmailVerificationRequestedHandler, ExistingAccountRegistrationAttemptedHandler } from './outbox-handlers';

/** Outbox consumers that notify people (design §14 `notifications/`). */
@Module({
  imports: [OutboxModule, OneTimePasswordsModule, UsersModule, EmailModule],
  providers: [EmailVerificationRequestedHandler, ExistingAccountRegistrationAttemptedHandler, ConversionPostedHandler],
})
export class NotificationsModule implements OnModuleInit {
  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly emailVerification: EmailVerificationRequestedHandler,
    private readonly existingAccount: ExistingAccountRegistrationAttemptedHandler,
    private readonly conversionPosted: ConversionPostedHandler,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this.emailVerification);
    this.dispatcher.register(this.existingAccount);
    this.dispatcher.register(this.conversionPosted);
  }
}
