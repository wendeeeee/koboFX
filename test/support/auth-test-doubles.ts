import { Clock } from '../../src/common/clock';
import { EmailMessage, EmailSender } from '../../src/modules/notifications/email/email-sender';

/** A clock tests can move forward (token expiry). Starts at real time. */
export class TestClock extends Clock {
  private offsetMilliseconds = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMilliseconds);
  }

  advance(milliseconds: number): void {
    this.offsetMilliseconds += milliseconds;
  }

  reset(): void {
    this.offsetMilliseconds = 0;
  }
}

/** Captures emails instead of sending them; can be told to fail, to exercise retries. */
export class CapturingEmailSender extends EmailSender {
  readonly sent: EmailMessage[] = [];
  private failuresToInject = 0;

  async send(message: EmailMessage): Promise<void> {
    if (this.failuresToInject > 0) {
      this.failuresToInject -= 1;
      throw new Error('Injected SMTP failure');
    }
    this.sent.push(message);
  }

  failNext(count: number): void {
    this.failuresToInject = count;
  }

  sentTo(address: string): EmailMessage[] {
    return this.sent.filter((message) => message.to === address);
  }

  /** The code in the most recent verification email to this address. */
  latestCodeFor(address: string): string {
    const codes = this.sentTo(address)
      .map((message) => /verification code is (\d{6})\./.exec(message.text)?.[1])
      .filter((code): code is string => code !== undefined);
    const code = codes[codes.length - 1];
    if (!code) throw new Error(`No verification code was emailed to ${address}`);
    return code;
  }
}
