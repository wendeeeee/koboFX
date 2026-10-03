import { ValidationOptions, registerDecorator } from 'class-validator';
import { COMMON_PASSWORDS } from './common-passwords';

/**
 * Password policy:
 * - 12 to 128 characters (Unicode code points) after NFKC normalisation.
 */
export const MINIMUM_PASSWORD_LENGTH = 12;
export const MAXIMUM_PASSWORD_LENGTH = 128;

export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

export type PasswordProblem = 'TOO_SHORT' | 'TOO_LONG' | 'TOO_COMMON' | 'REPETITIVE';

export function passwordProblem(password: string): PasswordProblem | null {
  const normalized = normalizePassword(password);
  const length = [...normalized].length;
  if (length < MINIMUM_PASSWORD_LENGTH) return 'TOO_SHORT';
  if (length > MAXIMUM_PASSWORD_LENGTH) return 'TOO_LONG';
  if (COMMON_PASSWORDS.has(normalized.toLowerCase())) return 'TOO_COMMON';
  if (/^(.{1,4})\1+$/su.test(normalized)) return 'REPETITIVE';
  return null;
}

const MESSAGES: Record<PasswordProblem, string> = {
  TOO_SHORT: `must be at least ${MINIMUM_PASSWORD_LENGTH} characters`,
  TOO_LONG: `must be at most ${MAXIMUM_PASSWORD_LENGTH} characters`,
  TOO_COMMON: 'is too common; choose another',
  REPETITIVE: 'is a repeated pattern; choose another',
};

export function IsAcceptablePassword(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) =>
    registerDecorator({
      name: 'isAcceptablePassword',
      target: target.constructor,
      propertyName: propertyName as string,
      options: {
        message: ({ value }) => {
          const problem = typeof value === 'string' ? passwordProblem(value) : 'TOO_SHORT';
          return `${String(propertyName)} ${MESSAGES[problem ?? 'TOO_SHORT']}`;
        },
        ...options,
      },
      validator: { validate: (value: unknown) => typeof value === 'string' && passwordProblem(value) === null },
    });
}
