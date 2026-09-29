import { CallHandler, ExecutionContext, HttpStatus, Injectable, NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Observable, from, lastValueFrom } from 'rxjs';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { RequestContext } from '../../context';
import { currentUserFrom } from '../../decorators/current-user.decorator';
import { IDEMPOTENT_KEY, IdempotentOptions } from '../../decorators/idempotent.decorator';
import { InvariantViolationError } from '../../errors';
import { buildErrorResponse } from '../../filters/error-response';
import { IDEMPOTENCY_KEY_PATTERN, IdempotencyKeyStatus, classifyFailure, decide } from './idempotency-decision';
import { IdempotencyKeyStore, IdempotencyScope } from './idempotency-key.store';
import { IdempotencyMetrics } from './idempotency-metrics';
import {
  IdempotencyKeyInvalidError,
  IdempotencyKeyRequiredError,
  IdempotencyKeyReuseError,
  RequestInProgressError,
  StoredResponse,
} from './idempotency.errors';
import { requestHash } from './request-hash';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

const SAVEPOINT = 'idempotent_handler';

type Outcome =
  | { readonly kind: 'SUCCESS'; readonly value: unknown }
  | { readonly kind: 'STORED'; readonly response: StoredResponse };

/**
 * The idempotency barrier (design §6.5; handbook: idempotency), for `@Idempotent()`
 * routes. Scope: (user, endpoint, key). In ONE database transaction:
 *
 * 1. a transaction-scoped advisory lock on the scope — held by a live request, so a
 *    concurrent duplicate gets `409 REQUEST_IN_PROGRESS` + `Retry-After` immediately;
 * 2. the atomic single-statement claim (`INSERT … ON CONFLICT DO NOTHING RETURNING`);
 *    not claimed ⇒ a different body is `409 IDEMPOTENCY_KEY_REUSE`, a stored outcome
 *    is replayed byte for byte with `Idempotent-Replayed: true`;
 * 3. `SAVEPOINT`, then the handler (pipes included) in the same transaction;
 * 4. success ⇒ the exact response bytes are stored, COMPLETED; a permanent failure ⇒
 *    rolled back to the savepoint and stored as FAILED_PERMANENT; a transient failure ⇒
 *    the whole transaction rolls back, so the key never existed and a retry
 *    genuinely reprocesses.
 *
 * Because claim, work and response commit together, a crash can never leave a key
 * without its work, work without its key, or a key stuck IN_PROGRESS. Keys never expire.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly unitOfWork: UnitOfWork,
    private readonly store: IdempotencyKeyStore,
    private readonly metrics: IdempotencyMetrics,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<IdempotentOptions | undefined>(IDEMPOTENT_KEY, context.getHandler());
    if (!options) return next.handle();
    return from(this.handle(context, next, options));
  }

  private async handle(context: ExecutionContext, next: CallHandler, options: IdempotentOptions): Promise<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<{ method: string; route?: { path?: string }; body: unknown; header(name: string): string | undefined }>();
    // Nest applies @HttpCode after interceptors, so read it from the route, not the response.
    const successStatus =
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler()) ??
      (request.method.toUpperCase() === 'POST' ? HttpStatus.CREATED : HttpStatus.OK);
    const user = currentUserFrom(context);

    const key = request.header(IDEMPOTENCY_KEY_HEADER);
    if (key === undefined || key === '') throw new IdempotencyKeyRequiredError();
    if (!IDEMPOTENCY_KEY_PATTERN.test(key)) throw new IdempotencyKeyInvalidError();
    const routePath = request.route?.path;
    if (!routePath) throw new InvariantViolationError('An @Idempotent() route has no route path.');
    const scope: IdempotencyScope = { userId: user.id, endpoint: `${request.method.toUpperCase()} ${routePath}`, key };
    const hash = requestHash(scope.endpoint, request.body);

    const outcome = await this.unitOfWork.run(async (manager): Promise<Outcome> => {
      if (!(await this.store.tryLock(manager, scope))) throw new RequestInProgressError();
      const claimed = await this.store.claim(manager, scope, hash);
      const decision = decide(claimed, claimed ? null : await this.store.find(manager, scope), hash);
      switch (decision.kind) {
        case 'IN_PROGRESS':
          throw new RequestInProgressError();
        case 'KEY_REUSED':
          throw new IdempotencyKeyReuseError();
        case 'REPLAY':
          return { kind: 'STORED', response: new StoredResponse(decision.statusCode, decision.body, true) };
        case 'PROCEED':
          break;
      }

      await manager.query(`SAVEPOINT ${SAVEPOINT}`);
      try {
        const value = await lastValueFrom(next.handle(), { defaultValue: undefined });
        const body = JSON.stringify(value ?? null);
        const flowId = options.flowIdField ? flowIdOf(value, options.flowIdField) : undefined;
        await this.store.complete(manager, scope, {
          status: IdempotencyKeyStatus.COMPLETED,
          statusCode: successStatus,
          body,
          flowId,
        });
        return { kind: 'SUCCESS', value };
      } catch (error) {
        if (classifyFailure(error) === 'TRANSIENT') throw error;
        await manager.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
        const rendered = buildErrorResponse(error, RequestContext.correlationId() ?? null);
        const body = JSON.stringify(rendered.body);
        await this.store.complete(manager, scope, {
          status: IdempotencyKeyStatus.FAILED_PERMANENT,
          statusCode: rendered.status,
          body,
        });
        return { kind: 'STORED', response: new StoredResponse(rendered.status, body, false) };
      }
    });

    if (outcome.kind === 'SUCCESS') return outcome.value;
    if (outcome.response.replayed) this.metrics.recordReplay();
    throw outcome.response;
  }
}

function flowIdOf(value: unknown, field: string): string | undefined {
  const candidate = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[field] : undefined;
  return typeof candidate === 'string' ? candidate : undefined;
}
