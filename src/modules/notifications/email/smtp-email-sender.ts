import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Transporter, createTransport } from 'nodemailer';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { EmailMessage, EmailSender } from './email-sender';

/** SMTP adapter (handbook: all calls will fail — so every call has a timeout). */
@Injectable()
export class SmtpEmailSender extends EmailSender implements OnModuleDestroy {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super();
    const { smtp, from } = config.mail;
    this.from = from;
    this.transporter = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.password } } : {}),
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.text });
  }

  onModuleDestroy(): void {
    this.transporter.close();
  }
}
