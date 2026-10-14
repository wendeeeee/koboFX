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

export function withdrawalCodeEmail(to: string, code: string, validForMinutes: number): EmailMessage {
  return {
    to,
    subject: 'Your KoboFX withdrawal code',
    text: [
      `Your KoboFX withdrawal code is ${code}.`,
      '',
      `Enter it with the amount to confirm ONE withdrawal. It is valid for ${validForMinutes} minutes; if you asked for`,
      'more than one code, only the most recent one works.',
      '',
      'Never share this code. KoboFX staff will never ask for it. If you did not ask to withdraw, do not use the code,',
      'and change your password.',
    ].join('\n'),
  };
}

export function transactionPinResetCodeEmail(to: string, code: string, validForMinutes: number): EmailMessage {
  return {
    to,
    subject: 'Your KoboFX transaction PIN reset code',
    text: [
      `Your KoboFX code to reset your transaction PIN is ${code}.`,
      '',
      `Enter it with your password and a new PIN. It is valid for ${validForMinutes} minutes; if you asked for more than`,
      'one code, only the most recent one works.',
      '',
      'Never share this code. If you did not ask to reset your PIN, ignore this email and change your password.',
    ].join('\n'),
  };
}

export type TransactionPinChange = 'CREATED' | 'CHANGED' | 'RESET' | 'LOCKED';

/** A security notice: every change to the transaction PIN is told to the account's email. Never contains the PIN. */
export function transactionPinChangedEmail(to: string, change: TransactionPinChange): EmailMessage {
  const what = {
    CREATED: ['Your transaction PIN was created', 'A transaction PIN was just created for your KoboFX account.'],
    CHANGED: ['Your transaction PIN was changed', 'The transaction PIN on your KoboFX account was just changed.'],
    RESET: ['Your transaction PIN was reset', 'The transaction PIN on your KoboFX account was just reset.'],
    LOCKED: ['Your transaction PIN is locked', 'Your transaction PIN was locked after too many wrong attempts. Reset it with your password and an emailed code to withdraw or exchange again.'],
  }[change];
  return {
    to,
    subject: `KoboFX: ${what[0]}`,
    text: [what[1], '', 'If this was not you, change your password now and contact support.'].join('\n'),
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
