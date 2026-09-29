import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { IdempotencyKeyStatus, StoredIdempotencyKey } from './idempotency-decision';

export interface IdempotencyScope {
  readonly userId: string;
  readonly endpoint: string;
  readonly key: string;
}

/** `idempotency_keys` (design §6.5). Every method runs on the barrier's transaction. */
@Injectable()
export class IdempotencyKeyStore {
  /**
   * Liveness, not dedupe: a transaction-scoped advisory lock on the scope. Held until
   * the owning transaction commits or rolls back — and released by Postgres if the
   * process dies — so a duplicate arriving meanwhile gets `REQUEST_IN_PROGRESS` at once
   * instead of queueing, and an abandoned request can never block its key.
   */
  async tryLock(manager: EntityManager, scope: IdempotencyScope): Promise<boolean> {
    const [row] = (await manager.query(`SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked`, [
      `idempotency|${scope.userId}|${scope.endpoint}|${scope.key}`,
    ])) as { locked: boolean }[];
    return row.locked;
  }

  /** The atomic claim — ONE statement (design §6.5). `true` when this request owns the key. */
  async claim(manager: EntityManager, scope: IdempotencyScope, requestHash: string): Promise<boolean> {
    const rows = (await manager.query(
      `INSERT INTO idempotency_keys (user_id, endpoint, key, request_hash, status)
       VALUES ($1, $2, $3, $4, 'IN_PROGRESS')
       ON CONFLICT (user_id, endpoint, key) DO NOTHING
       RETURNING key`,
      [scope.userId, scope.endpoint, scope.key, requestHash],
    )) as unknown[];
    return rows.length === 1;
  }

  async find(manager: EntityManager, scope: IdempotencyScope): Promise<StoredIdempotencyKey | null> {
    const [row] = (await manager.query(
      `SELECT status, request_hash, response_status_code, response_body FROM idempotency_keys
        WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
      [scope.userId, scope.endpoint, scope.key],
    )) as { status: IdempotencyKeyStatus; request_hash: string; response_status_code: number | null; response_body: string | null }[];
    return row
      ? {
          status: row.status,
          requestHash: row.request_hash,
          responseStatusCode: row.response_status_code,
          responseBody: row.response_body,
        }
      : null;
  }

  async complete(
    manager: EntityManager,
    scope: IdempotencyScope,
    outcome: {
      status: IdempotencyKeyStatus.COMPLETED | IdempotencyKeyStatus.FAILED_PERMANENT;
      statusCode: number;
      body: string;
      flowId?: string;
    },
  ): Promise<void> {
    await manager.query(
      `UPDATE idempotency_keys
          SET status = $4, response_status_code = $5, response_body = $6, flow_id = $7, completed_at = now()
        WHERE user_id = $1 AND endpoint = $2 AND key = $3 AND status = 'IN_PROGRESS'`,
      [scope.userId, scope.endpoint, scope.key, outcome.status, outcome.statusCode, outcome.body, outcome.flowId ?? null],
    );
  }
}
