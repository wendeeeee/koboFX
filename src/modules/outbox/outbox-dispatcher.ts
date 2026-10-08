import { Inject, Injectable, Logger } from '@nestjs/common';
import { InvariantViolationError } from '../../common/errors';
import { exponentialBackoffSeconds } from '../../common/polling/backoff';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig, OutboxConfig } from '../../config/configuration';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { ClaimedOutboxEvent, OutboxEventHandler } from './outbox.types';

export const OUTBOX_CLAIM_LEASE_SECONDS = 60;
const MAXIMUM_BACKOFF_SECONDS = 3600;
const MAXIMUM_ERROR_LENGTH = 500;

export interface DispatchReport {
  readonly claimed: number;
  readonly published: number;
  readonly retried: number;
  readonly deadLettered: number;
}

/** Exponential backoff after the n-th failed attempt: 5s, 10s, 20s … capped at one hour. */
export function backoffSeconds(attempts: number): number {
  return exponentialBackoffSeconds(attempts, 5, MAXIMUM_BACKOFF_SECONDS);
}


@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private readonly handlers = new Map<string, OutboxEventHandler>();
  private readonly config: OutboxConfig;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    @Inject(APP_CONFIG) appConfig: AppConfig,
  ) {
    this.config = appConfig.outbox;
  }

  register(handler: OutboxEventHandler): void {
    if (this.handlers.has(handler.eventType)) {
      throw new InvariantViolationError(`Two outbox handlers registered for ${handler.eventType}.`);
    }
    this.handlers.set(handler.eventType, handler);
  }

  async dispatchDue(batchSize = this.config.batchSize): Promise<DispatchReport> {
    const events = await this.claim(batchSize);
    let published = 0;
    let retried = 0;
    let deadLettered = 0;
    for (const event of events) {
      const handler = this.handlers.get(event.eventType);
      try {
        if (!handler) throw new Error(`No handler registered for ${event.eventType}`);
        await handler.handle(event);
        await this.markPublished(event.id);
        published += 1;
      } catch (error) {
        const deadLetter = event.attempts >= this.config.maxAttempts;
        await this.recordFailure(event, error, deadLetter);
        if (deadLetter) deadLettered += 1;
        else retried += 1;
      }
    }
    return { claimed: events.length, published, retried, deadLettered };
  }

  private async claim(batchSize: number): Promise<ClaimedOutboxEvent[]> {
    const rows = (await this.unitOfWork.manager.query(
      `WITH due AS (
         SELECT id FROM outbox_events
          WHERE published_at IS NULL AND failed_at IS NULL AND next_attempt_at <= now()
          ORDER BY next_attempt_at, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE outbox_events
            SET attempts = outbox_events.attempts + 1,
                next_attempt_at = now() + make_interval(secs => $2)
           FROM due
          WHERE outbox_events.id = due.id
         RETURNING outbox_events.id, outbox_events.event_type, outbox_events.aggregate_id,
                   outbox_events.payload, outbox_events.attempts, outbox_events.created_at
       )
       SELECT * FROM claimed ORDER BY created_at, id`,
      [batchSize, OUTBOX_CLAIM_LEASE_SECONDS],
    )) as { id: string; event_type: string; aggregate_id: string; payload: unknown; attempts: number }[];
    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      aggregateId: row.aggregate_id,
      payload: row.payload,
      attempts: row.attempts,
    }));
  }

  private async markPublished(eventId: string): Promise<void> {
    await this.unitOfWork.manager.query(
      `UPDATE outbox_events SET published_at = now(), last_error = NULL WHERE id = $1 AND published_at IS NULL`,
      [eventId],
    );
  }

  private async recordFailure(event: ClaimedOutboxEvent, error: unknown, deadLetter: boolean): Promise<void> {
    const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, MAXIMUM_ERROR_LENGTH);
    this.logger.error(
      { outboxEventId: event.id, eventType: event.eventType, attempts: event.attempts, deadLetter, err: error },
      deadLetter ? 'Outbox event dead-lettered' : 'Outbox event failed; will retry',
    );
    await this.unitOfWork.manager.query(
      deadLetter
        ? `UPDATE outbox_events SET failed_at = now(), last_error = $2 WHERE id = $1 AND published_at IS NULL`
        : `UPDATE outbox_events SET next_attempt_at = now() + make_interval(secs => $3), last_error = $2
            WHERE id = $1 AND published_at IS NULL`,
      deadLetter ? [event.id, message] : [event.id, message, backoffSeconds(event.attempts)],
    );
  }
}
