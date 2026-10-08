import { Module } from '@nestjs/common';
import { EmailSender } from './email-sender';
import { SmtpEmailSender } from './smtp-email-sender';

@Module({
  providers: [{ provide: EmailSender, useClass: SmtpEmailSender }],
  exports: [EmailSender],
})
export class EmailModule {}
