export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/**
 * The port an email provider plugs into. MailHog in dev and tests, any SMTP provider
 * in production (`SmtpEmailSender`); a provider SDK would be another adapter.
 *
 * `send` resolves once the provider accepted the message and rejects otherwise. The
 * caller (an outbox handler) retries — delivery is at-least-once, so every email we
 * send must be harmless to receive twice.
 */
export abstract class EmailSender {
  abstract send(message: EmailMessage): Promise<void>;
}
