import { Transform } from 'class-transformer';
import { ValidationOptions, registerDecorator } from 'class-validator';
import { isDisposableEmailAddress, isSupportedEmailAddress, normalizeEmailAddress } from '../email-address';

export function NormalizeEmailAddress(): PropertyDecorator {
  return Transform(({ value }) => (typeof value === 'string' ? normalizeEmailAddress(value) : value));
}

export function IsSupportedEmailAddress(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) =>
    registerDecorator({
      name: 'isSupportedEmailAddress',
      target: target.constructor,
      propertyName: propertyName as string,
      options: { message: `${String(propertyName)} must be a valid ASCII email address`, ...options },
      validator: { validate: (value: unknown) => typeof value === 'string' && isSupportedEmailAddress(value) },
    });
}

export function IsNotDisposableEmail(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) =>
    registerDecorator({
      name: 'isNotDisposableEmail',
      target: target.constructor,
      propertyName: propertyName as string,
      options: { message: `${String(propertyName)} must not be a disposable email address`, ...options },
      validator: { validate: (value: unknown) => typeof value === 'string' && !isDisposableEmailAddress(value) },
    });
}
