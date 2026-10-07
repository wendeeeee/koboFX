import { Clock } from '../../src/common/clock';
import { EmailMessage, EmailSender } from '../../src/modules/notifications/email/email-sender';


export class TestClock extends Clock {
  private offsetMilliseconds = 0;
  private frozenAt: number | undefined;

  now(): Date {
    return new Date((this.frozenAt ?? Date.now()) + this.offsetMilliseconds);
  }

  advance(milliseconds: number): void {
    this.offsetMilliseconds += milliseconds;
  }

  freeze(): void {
    // On a whole second: provider publication times (unix seconds) are then exact.
    this.frozenAt ??= Math.floor(Date.now() / 1000) * 1000;
  }

  reset(): void {
    this.offsetMilliseconds = 0;
    this.frozenAt = undefined;
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

  /** The code in the most recent withdrawal-code email to this address. */
  latestWithdrawalCodeFor(address: string): string {
    const codes = this.sentTo(address)
      .map((message) => /withdrawal code is (\d{6})\./.exec(message.text)?.[1])
      .filter((code): code is string => code !== undefined);
    const code = codes[codes.length - 1];
    if (!code) throw new Error(`No withdrawal code was emailed to ${address}`);
    return code;
  }
}
