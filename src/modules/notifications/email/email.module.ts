import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { BrevoEmailSender } from './brevo-email-sender';
import { EmailSender } from './email-sender';
import { SmtpEmailSender } from './smtp-email-sender';

@Module({
  providers: [
    {
      provide: EmailSender,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): EmailSender =>
        config.mail.transport === 'brevo' ? new BrevoEmailSender(config.mail) : new SmtpEmailSender(config.mail),
    },
  ],
  exports: [EmailSender],
})
export class EmailModule {}
