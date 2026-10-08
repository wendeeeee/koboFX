import { HttpException } from '@nestjs/common';
import { DomainError } from '../../errors';

export enum IdempotencyKeyStatus {
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED_PERMANENT = 'FAILED_PERMANENT',
}

export interface StoredIdempotencyKey {
  readonly status: IdempotencyKeyStatus;
  readonly requestHash: string;
  readonly requestHashAlgorithm: string;
  readonly requestHashKeyId: string | null;
  readonly responseStatusCode: number | null;
  readonly responseBody: string | null;
}

export type IdempotencyDecision =
  | { readonly kind: 'PROCEED' }
  | { readonly kind: 'REPLAY'; readonly statusCode: number; readonly body: string }
  | { readonly kind: 'KEY_REUSED' }
  | { readonly kind: 'IN_PROGRESS' };

/** The key header (design §6.5): 16–128 characters of `[A-Za-z0-9_-]` — a UUID fits. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * What to do with a request, given whether our single-statement claim inserted the key
 * and, if not, the row that was already there (design §6.5). Pure.
 *
 * - claimed → process it;
 * - another request's key with a different body → `IDEMPOTENCY_KEY_REUSE`;
 * - a final outcome (success or permanent failure) → replay it verbatim;
 * - still in progress → `REQUEST_IN_PROGRESS`.
 */
export function decide(claimed: boolean, existing: StoredIdempotencyKey | null, hash: string): IdempotencyDecision {
  if (claimed) return { kind: 'PROCEED' };
  if (!existing || existing.status === IdempotencyKeyStatus.IN_PROGRESS) return { kind: 'IN_PROGRESS' };
  if (existing.requestHash !== hash) return { kind: 'KEY_REUSED' };
  if (existing.responseStatusCode === null || existing.responseBody === null) return { kind: 'IN_PROGRESS' };
  return { kind: 'REPLAY', statusCode: existing.responseStatusCode, body: existing.responseBody };
}

/**
 * How a failure replays (design §6.5; handbook: decide how errors replay).
 *
 * - PERMANENT — the request itself is wrong or refused (a permanent `DomainError`, or a
 *   4xx from validation): stored and replayed; the client fixes it and uses a new key.
 * - TRANSIENT — busy, a dependency down, or anything unexpected (our bug, a 5xx): not
 *   stored, the transaction rolls back and the key is claimable again, so a retry
 *   genuinely reprocesses (after a fix, for a bug).
 */
export function classifyFailure(error: unknown): 'PERMANENT' | 'TRANSIENT' {
  if (error instanceof DomainError) return error.permanent && error.httpStatus < 500 ? 'PERMANENT' : 'TRANSIENT';
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return status >= 400 && status < 500 && status !== 429 ? 'PERMANENT' : 'TRANSIENT';
  }
  return 'TRANSIENT';
}
