import type { UnitOfWork } from './unit-of-work';

let current: UnitOfWork | undefined;

/** Called by UnitOfWork on module init; decorators have no DI access of their own. */
export function registerUnitOfWork(unitOfWork: UnitOfWork): void {
  current = unitOfWork;
}

export function unregisterUnitOfWork(unitOfWork: UnitOfWork): void {
  if (current === unitOfWork) current = undefined;
}

/**
 * Run the decorated async method inside `UnitOfWork.run()` — joining an ambient
 * transaction if there is one. Handlers use this to own the transaction boundary
 * (design §3.2).
 */
export function Transactional(): MethodDecorator {
  return (_target, propertyKey, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;
    if (typeof original !== 'function') {
      throw new TypeError(`@Transactional() can only decorate methods (${String(propertyKey)}).`);
    }
    descriptor.value = function (this: unknown, ...args: unknown[]) {
      if (!current) {
        throw new Error(
          `@Transactional() ${String(propertyKey)} called before UnitOfWork was initialised.`,
        );
      }
      return current.run(() => original.apply(this, args));
    };
    return descriptor;
  };
}
