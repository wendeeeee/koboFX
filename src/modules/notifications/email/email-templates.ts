import { EmailMessage } from './email-sender';

export function verificationCodeEmail(to: string, code: string, validForMinutes: number): EmailMessage {
  return {
    to,
    subject: 'Your KoboFX verification code',
    text: [
      `Your KoboFX verification code is ${code}.`,
      '',
      `It is valid for ${validForMinutes} minutes and can be used once. If you asked for more than one`,
      'code, only the most recent one works.',
      '',
      'If you did not sign up for KoboFX, you can ignore this email.',
    ].join('\n'),
  };
}

export function existingAccountEmail(to: string): EmailMessage {
  return {
    to,
    subject: 'You already have a KoboFX account',
    text: [
      'Someone tried to create a KoboFX account with this email address, but you already have one.',
      '',
      'If it was you, log in instead. If it was not, no action is needed: nothing about your account changed.',
    ].join('\n'),
  };
}
