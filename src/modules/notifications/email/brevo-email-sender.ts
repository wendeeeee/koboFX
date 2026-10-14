import { BrevoMailConfig } from '../../../config/configuration';
import { EmailMessage, EmailSender } from './email-sender';

export class BrevoEmailError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    detail: string,
  ) {
    super(`Brevo refused the email (${status}${code ? ` ${code}` : ''}): ${detail}`);
    this.name = 'BrevoEmailError';
  }
}

export function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!doctype html><html><body><div style="font-family:sans-serif;white-space:pre-wrap">${escaped}</div></body></html>`;
}

/** Brevo's transactional email API over HTTPS. A failure throws, so the outbox retries it. */
export class BrevoEmailSender extends EmailSender {
  private readonly endpoint: string;

  constructor(
    private readonly mail: BrevoMailConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    super();
    this.endpoint = `${mail.brevo.baseUrl}/v3/smtp/email`;
  }

  async send(message: EmailMessage): Promise<void> {
    const response = await this.fetchImplementation(this.endpoint, {
      method: 'POST',
      headers: { 'api-key': this.mail.brevo.apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: this.mail.sender,
        to: [{ email: message.to }],
        subject: message.subject,
        textContent: message.text,
        htmlContent: textToHtml(message.text),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return;
    let error: { code?: unknown; message?: unknown } = {};
    try {
      error = JSON.parse(await response.text()) as typeof error;
    } catch {
      // not JSON
    }
    const code = typeof error.code === 'string' ? error.code : undefined;
    const detail = typeof error.message === 'string' ? error.message.slice(0, 200) : response.statusText || 'no detail';
    throw new BrevoEmailError(response.status, code, detail);
  }
}
