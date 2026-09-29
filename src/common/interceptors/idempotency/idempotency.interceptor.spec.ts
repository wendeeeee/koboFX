import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyKeyStore } from './idempotency-key.store';
import { IdempotencyMetrics } from './idempotency-metrics';

function context(request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}
const request = (overrides: Record<string, unknown> = {}) => ({
  method: 'POST',
  route: { path: '/api/v1/wallet/fund' },
  body: {},
  user: { id: 'user-1' },
  header: () => 'k'.repeat(20),
  ...overrides,
});

describe('IdempotencyInterceptor (unit edges)', () => {
  const manager = { query: jest.fn(async () => []) };
  const unitOfWork = { run: (work: (m: unknown) => Promise<unknown>) => work(manager) } as unknown as UnitOfWork;
  const store = {
    tryLock: async () => true,
    claim: async () => true,
    find: async () => null,
    complete: jest.fn(async () => undefined),
  } as unknown as IdempotencyKeyStore;

  it('passes non-idempotent routes straight through', async () => {
    const reflector = { get: () => undefined } as unknown as Reflector;
    const interceptor = new IdempotencyInterceptor(reflector, unitOfWork, store, new IdempotencyMetrics());
    await expect(lastValueFrom(interceptor.intercept(context(request()), { handle: () => of('raw') } as CallHandler))).resolves.toBe('raw');
  });

  it('fails loudly on a route without a path, and stores an empty body as JSON null', async () => {
    const reflector = { get: (key: string) => (key === 'idempotency:options' ? { flowIdField: 'fundingId' } : undefined) } as unknown as Reflector;
    const interceptor = new IdempotencyInterceptor(reflector, unitOfWork, store, new IdempotencyMetrics());
    await expect(
      lastValueFrom(interceptor.intercept(context(request({ route: undefined })), { handle: () => of(1) } as CallHandler)),
    ).rejects.toThrow(/no route path/);
    await expect(
      lastValueFrom(interceptor.intercept(context(request({ method: 'PUT' })), { handle: () => of(undefined) } as CallHandler)),
    ).resolves.toBeUndefined();
    expect(store.complete).toHaveBeenLastCalledWith(manager, expect.anything(), expect.objectContaining({ statusCode: 200, body: 'null', flowId: undefined }));
  });
});
