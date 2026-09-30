import { Injectable, Logger } from '@nestjs/common';
import { InvariantViolationError } from '../../common/errors';
import { DependencyUnavailableError } from '../../common/errors';
import { ExchangeRateSnapshotRepository } from '../fx/exchange-rate-snapshot.repository';
import { FxRateFetcher } from '../fx/fx-rate-fetcher';
import { RateCache } from '../fx/rate-cache';
import {
  ApprovalChangedPayload,
  BreakGlassPayload,
  ClaimedOutboxEvent,
  ExchangeRateOverriddenPayload,
  OutboxEventHandler,
  OutboxEventType,
} from '../outbox/outbox.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireId(event: ClaimedOutboxEvent, value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value) || value !== event.aggregateId) {
    throw new InvariantViolationError(`Outbox event ${event.id} has a malformed payload.`);
  }
  return value;
}

/** `ApprovalChanged.v1` → acknowledged (approver notifications and alert routing are a later phase). Idempotent. */
@Injectable()
export class ApprovalChangedHandler implements OutboxEventHandler {
  readonly eventType = OutboxEventType.APPROVAL_CHANGED;
  private readonly logger = new Logger(ApprovalChangedHandler.name);

  async handle(event: ClaimedOutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as Partial<ApprovalChangedPayload>;
    const approvalId = requireId(event, payload.approvalId);
    this.logger.log({ eventId: event.id, approvalId, actionType: payload.actionType, status: payload.status }, 'Approval change: acknowledged');
  }
}

/**
 * `BreakGlassUsed.v1` / `BreakGlassReviewOverdue.v1` → the security page (design §9.2). No alert router yet: the
 * page is this ERROR log line (plus the metric the service already moved); routing it is a later phase. Idempotent.
 */
abstract class BreakGlassPageHandler implements OutboxEventHandler {
  abstract readonly eventType: OutboxEventType;
  protected abstract readonly message: string;
  private readonly logger = new Logger('BreakGlassPage');

  async handle(event: ClaimedOutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as Partial<BreakGlassPayload>;
    const approvalId = requireId(event, payload.approvalId);
    this.logger.error({ eventId: event.id, approvalId, actionType: payload.actionType, actorId: payload.actorId, page: 'security' }, this.message);
  }
}

@Injectable()
export class BreakGlassUsedHandler extends BreakGlassPageHandler {
  readonly eventType = OutboxEventType.BREAK_GLASS_USED;
  protected readonly message = 'PAGE security: break-glass used';
}

@Injectable()
export class BreakGlassReviewOverdueHandler extends BreakGlassPageHandler {
  readonly eventType = OutboxEventType.BREAK_GLASS_REVIEW_OVERDUE;
  protected readonly message = 'PAGE security: break-glass use not reviewed in time';
}

/**
 * `ExchangeRateOverridden.v1` → offer the new ACCEPTED snapshot to Redis (request handlers never write Redis,
 * Phase 6 decision 7). Compare-and-set by fetch order: a newer snapshot already cached wins, which is right.
 * Redis down → retried by the outbox (the read path falls back to the database meanwhile). Idempotent.
 */
@Injectable()
export class ExchangeRateOverriddenHandler implements OutboxEventHandler {
  readonly eventType = OutboxEventType.EXCHANGE_RATE_OVERRIDDEN;
  private readonly logger = new Logger(ExchangeRateOverriddenHandler.name);

  constructor(
    private readonly snapshots: ExchangeRateSnapshotRepository,
    private readonly cache: RateCache,
    private readonly fetcher: FxRateFetcher,
  ) {}

  async handle(event: ClaimedOutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as Partial<ExchangeRateOverriddenPayload>;
    const snapshotId = requireId(event, payload.snapshotId);
    const snapshot = await this.snapshots.findAccepted(snapshotId);
    if (!snapshot) throw new InvariantViolationError(`Overridden snapshot ${snapshotId} is not an ACCEPTED snapshot.`);
    try {
      const written = await this.cache.offer(snapshot, this.fetcher.cacheTimeToLiveSeconds);
      this.logger.log({ eventId: event.id, snapshotId, cached: written }, 'Overridden rate offered to the cache');
    } catch (error) {
      if (error instanceof DependencyUnavailableError) throw error; // retried by the outbox
      throw error;
    }
  }
}
