import { randomUUID } from 'node:crypto';
import { InvariantViolationError, ValidationError } from '../../common/errors';
import { dec } from '../../common/money';
import { AppConfig } from '../../config/configuration';
import { ExchangeRateSnapshotRepository, RateSnapshot } from '../fx/exchange-rate-snapshot.repository';
import { FxRateFetcher } from '../fx/fx-rate-fetcher';
import { RateCache } from '../fx/rate-cache';
import { ClaimedOutboxEvent } from '../outbox/outbox.types';
import { BreakStatus } from '../reconciliation/break-transitions';
import { ApprovalChangedHandler, BreakGlassReviewOverdueHandler, BreakGlassUsedHandler, ExchangeRateOverriddenHandler } from './admin-event-handlers';
import { AdminMetrics } from './admin-metrics';
import * as errors from './admin.errors';
import { ApprovalActionType } from './approvals/approval.types';
import { ApprovalService } from './approvals/approval.service';
import { AdminMonitor } from './break-glass/admin-monitor';
import { parseActionPayload } from './actions/action-payloads';
import { markBook } from './positions/position-marking';
import { parseBreakStatusFilter } from './reads/admin-reads.service';

const event = (payload: unknown, aggregateId: string): ClaimedOutboxEvent => ({ id: '1', eventType: 'x', aggregateId, payload, attempts: 1 });

describe('admin support pieces', () => {
  it('metrics: counters per action and outcome, the unreviewed gauge', () => {
    const metrics = new AdminMetrics();
    metrics.recordBreakGlassUse('SUSPEND_USER');
    metrics.recordBreakGlassUse('SUSPEND_USER');
    metrics.recordBreakGlassUse('RATE_OVERRIDE');
    metrics.recordOutcome('WRITE_OFF', 'EXECUTED');
    metrics.recordOutcome('CORRECTION', 'REJECTED');
    metrics.recordUnreviewedBreakGlass({ withinWindow: 2, overdue: 1 });
    expect(metrics.breakGlassUsedTotal()).toEqual([{ action: 'RATE_OVERRIDE', count: 1 }, { action: 'SUSPEND_USER', count: 2 }]);
    expect(metrics.approvalsTotal()).toEqual([
      { action: 'CORRECTION', outcome: 'REJECTED', count: 1 },
      { action: 'WRITE_OFF', outcome: 'EXECUTED', count: 1 },
    ]);
    expect(metrics.breakGlassUnreviewed).toEqual({ withinWindow: 2, overdue: 1 });
  });

  it('the monitor loop sweeps on its tick and stops cleanly', async () => {
    let sweeps = 0;
    const approvals = { sweep: async () => ((sweeps += 1), { expired: 0, overdueAlerted: 0 }) } as unknown as ApprovalService;
    const monitor = new AdminMonitor(approvals, { admin: { monitorTickMilliseconds: 50 } } as AppConfig);
    monitor.start();
    const deadline = Date.now() + 3_000;
    while (sweeps < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    await monitor.stop();
    expect(sweeps).toBeGreaterThanOrEqual(2);
  });

  it('event handlers refuse a malformed payload; the page handlers acknowledge; the override handler offers the snapshot', async () => {
    const id = randomUUID();
    for (const handler of [new ApprovalChangedHandler(), new BreakGlassUsedHandler(), new BreakGlassReviewOverdueHandler()]) {
      await expect(handler.handle(event({ approvalId: 'nope' }, id))).rejects.toThrow(InvariantViolationError);
      await expect(handler.handle(event({ approvalId: id, actionType: 'SUSPEND_USER', status: 'EXECUTED', actorId: id }, id))).resolves.toBeUndefined();
    }
    const snapshot = { id, provider: 'p', providerUpdatedAt: new Date(), providerNextUpdateAt: new Date(), fetchedAt: new Date(), rates: new Map() } as RateSnapshot;
    const offered: string[] = [];
    const found = { findAccepted: async (snapshotId: string) => (snapshotId === id ? snapshot : undefined) } as unknown as ExchangeRateSnapshotRepository;
    const cache = { offer: async (offeredSnapshot: RateSnapshot) => (offered.push(offeredSnapshot.id), true) } as unknown as RateCache;
    const handler = new ExchangeRateOverriddenHandler(found, cache, { cacheTimeToLiveSeconds: 60 } as FxRateFetcher);
    await handler.handle(event({ snapshotId: id, approvalId: id }, id));
    expect(offered).toEqual([id]);
    const other = randomUUID();
    await expect(handler.handle(event({ snapshotId: other, approvalId: id }, other))).rejects.toThrow(/not an ACCEPTED snapshot/);
    await expect(handler.handle(event({}, id))).rejects.toThrow(InvariantViolationError);
  });

  it('every admin error carries its code and status', () => {
    const id = randomUUID();
    const all = [
      new errors.ApprovalNotFoundError(id),
      new errors.UserNotFoundError(id),
      new errors.ReconciliationRunNotFoundError(id),
      new errors.SelfApprovalForbiddenError(id),
      new errors.ApprovalAlreadyDecidedError(id, 'EXECUTED'),
      new errors.ApprovalExpiredError(id, new Date()),
      new errors.ApprovalRequesterIneligibleError(id),
      new errors.BreakGlassNotAllowedError({ actionType: 'CORRECTION' }),
      new errors.BreakGlassAlreadyReviewedError(id),
      new errors.ActionPreconditionFailedError('X', 'y'),
    ];
    expect(all.map((error) => [error.code, error.httpStatus])).toEqual([
      ['APPROVAL_NOT_FOUND', 404],
      ['USER_NOT_FOUND', 404],
      ['RECONCILIATION_RUN_NOT_FOUND', 404],
      ['SELF_APPROVAL_FORBIDDEN', 403],
      ['APPROVAL_ALREADY_DECIDED', 409],
      ['APPROVAL_EXPIRED', 409],
      ['APPROVAL_REQUESTER_INELIGIBLE', 409],
      ['BREAK_GLASS_NOT_ALLOWED', 403],
      ['BREAK_GLASS_ALREADY_REVIEWED', 409],
      ['ACTION_PRECONDITION_FAILED', 409],
    ]);
  });

  it('small guards: break status filter, a non-positive rate, a tampered canonical period', () => {
    expect(parseBreakStatusFilter(undefined)).toBeNull();
    expect(parseBreakStatusFilter('LIVE')).toBe('LIVE');
    expect(parseBreakStatusFilter('ESCALATED')).toBe(BreakStatus.ESCALATED);
    expect(() => parseBreakStatusFilter('BROKEN')).toThrow(ValidationError);
    expect(() => markBook([{ currency: 'NGN', minorUnit: 2, positionMinor: 1n, usdRate: dec('0') }], 2)).toThrow(InvariantViolationError);
    expect(() =>
      parseActionPayload(ApprovalActionType.CLOSE_PERIOD, { month: '2026-08', periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-09-01T00:00:00.000Z' }),
    ).toThrow(ValidationError);
  });
});
