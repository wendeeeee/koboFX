export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export abstract class EmailSender {
  abstract send(message: EmailMessage): Promise<void>;
}
