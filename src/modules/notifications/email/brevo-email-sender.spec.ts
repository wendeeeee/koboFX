import { BrevoMailConfig } from '../../../config/configuration';
import { BrevoEmailError, BrevoEmailSender, textToHtml } from './brevo-email-sender';

const MAIL: BrevoMailConfig = {
  transport: 'brevo',
  brevo: { apiKey: 'xkeysib-test-key', baseUrl: 'https://api.brevo.test' },
  from: 'KoboFX Demo <demo@example.com>',
  sender: { name: 'KoboFX Demo', email: 'demo@example.com' },
};

function fakeFetch(status: number, body: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const implementation = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, implementation };
}

describe('BrevoEmailSender', () => {
  it('posts one transactional email: api-key header, parsed sender, text and escaped HTML', async () => {
    const fake = fakeFetch(201, '{"messageId":"<id@smtp-relay.mailin.fr>"}');
    await new BrevoEmailSender(MAIL, fake.implementation).send({ to: 'ada@example.com', subject: 'Your code', text: 'Code: 123456\n<b>not bold</b>' });
    expect(fake.calls).toHaveLength(1);
    const [{ url, init }] = fake.calls;
    expect(url).toBe('https://api.brevo.test/v3/smtp/email');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'api-key': 'xkeysib-test-key', 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      sender: { name: 'KoboFX Demo', email: 'demo@example.com' },
      to: [{ email: 'ada@example.com' }],
      subject: 'Your code',
      textContent: 'Code: 123456\n<b>not bold</b>',
      htmlContent: textToHtml('Code: 123456\n<b>not bold</b>'),
    });
    expect(textToHtml('<b>&"')).toContain('&lt;b&gt;&amp;&quot;');
  });

  it("throws on a refusal with Brevo's status, code and message — never the API key", async () => {
    const fake = fakeFetch(401, '{"code":"unauthorized","message":"Key not found"}');
    const sending = new BrevoEmailSender(MAIL, fake.implementation).send({ to: 'ada@example.com', subject: 's', text: 't' });
    await expect(sending).rejects.toBeInstanceOf(BrevoEmailError);
    await expect(sending).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    await expect(sending).rejects.toThrow('Brevo refused the email (401 unauthorized): Key not found');
    await sending.catch((error: Error) => expect(error.message).not.toContain('xkeysib-test-key'));
  });

  it('a non-JSON error body is reported by status only', async () => {
    const fake = fakeFetch(502, '<html>bad gateway</html>');
    await expect(new BrevoEmailSender(MAIL, fake.implementation).send({ to: 'a@example.com', subject: 's', text: 't' })).rejects.toMatchObject({
      status: 502,
      code: undefined,
    });
  });
});
