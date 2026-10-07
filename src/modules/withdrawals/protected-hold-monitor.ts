import { Inject, Injectable, Logger } from '@nestjs/common';
import { PollingLoop } from '../../common/polling/polling-loop';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { AuditAction, AuditLogService, AuditSubjectType } from '../audit/audit-log.service';
import { OutboxService } from '../outbox/outbox.service';
import { OutboxEventType, ProtectedHoldFlaggedPayload } from '../outbox/outbox.types';
import { WithdrawalReviewReason, openReview } from './withdrawal-reviews';

/** Why a protected hold needs a human. Ordered: the first that applies is reported. */
export enum ProtectedHoldCondition {
  /** No withdrawal links the hold, or its flow is missing (impossible by deferred FKs: corruption). */
  ORPHAN = 'ORPHAN',
  /** The flow finished but its hold is still ACTIVE (impossible by the consistency trigger: corruption). */
  TERMINAL_FLOW = 'TERMINAL_FLOW',
  /** Recorded payout work but the credentials or key rings to process it are absent. */
  CREDENTIALS_MISSING = 'CREDENTIALS_MISSING',
  /** Nothing will look at the flow soon: not due within two hours. */
  NO_RECOVERABLE_SCHEDULE = 'NO_RECOVERABLE_SCHEDULE',
  /** Past its review deadline (`PAYSTACK_WITHDRAWAL_REVIEW_DEADLINE_MINUTES`): a finite review deadline, never a release. */
  OVERDUE = 'OVERDUE',
}

/** Metric hooks (no backend): `protected_holds_flagged_total{condition}`, `protected_holds_attention` (gauge). */
@Injectable()
export class ProtectedHoldMetrics {
  readonly flaggedTotal = new Map<ProtectedHoldCondition, number>();
  attention = 0;

  flagged(condition: ProtectedHoldCondition): void {
    this.flaggedTotal.set(condition, (this.flaggedTotal.get(condition) ?? 0) + 1);
  }
}

interface HoldRow {
  reservation_id: string;
  flow_id: string;
  flow_exists: boolean;
  withdrawal_id: string | null;
  completed: boolean | null;
  state: string | null;
  overdue: boolean;
  unscheduled: boolean;
}

const MONITOR_ACTOR = 'job:protected-hold-monitor';

/**
 * The protected-hold monitor (WITHDRAWAL_PLAN.md §G.2): a worker loop over EVERY `FLOW_CONTROLLED` ACTIVE hold —
 * overdue ones included — that pages on orphans, terminal flows still holding money, holds nothing will look at soon,
 * missing recovery credentials, and holds past their review deadline. Each newly flagged hold opens a review on its
 * withdrawal (`PROTECTED_HOLD_OVERDUE`) with an audit row, a `ProtectedHoldFlagged.v1` event and a metric, in one
 * transaction; a hold is paged once per condition. It NEVER releases, expires or settles anything: the hold stays
 * until its flow resolves it with evidence. The hourly reconciliation run owns the run-linked break.
 */
@Injectable()
export class ProtectedHoldMonitor {
  private readonly logger = new Logger(ProtectedHoldMonitor.name);
  private readonly loop: PollingLoop;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditLogService,
    private readonly outbox: OutboxService,
    private readonly metrics: ProtectedHoldMetrics,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.loop = new PollingLoop(
      ProtectedHoldMonitor.name,
      async () => {
        await this.tick();
        return { fullBatch: false };
      },
      () => config.admin.monitorTickMilliseconds,
    );
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  /** One pass. Returns the holds newly flagged (each paged once per condition). */
  async tick(): Promise<{ reservationId: string; flowId: string; condition: ProtectedHoldCondition }[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT reservations.id AS reservation_id, reservations.flow_id,
              flow_instances.id IS NOT NULL AS flow_exists, paystack_withdrawals.flow_id AS withdrawal_id,
              flow_instances.completed_at IS NOT NULL AS completed, flow_instances.state,
              reservations.expires_at < now() AS overdue,
              (flow_instances.completed_at IS NULL AND flow_instances.next_attempt_at > now() + interval '2 hours') AS unscheduled
         FROM reservations
         LEFT JOIN flow_instances ON flow_instances.id = reservations.flow_id
         LEFT JOIN paystack_withdrawals ON paystack_withdrawals.reservation_id = reservations.id
        WHERE reservations.status = 'ACTIVE' AND reservations.expiry_policy = 'FLOW_CONTROLLED'
        ORDER BY reservations.expires_at, reservations.id`,
    )) as HoldRow[];
    const credentialsMissing = !this.config.paystack.secretKey || !this.config.protection.keyEncryption || !this.config.protection.fingerprint;
    const flagged: { reservationId: string; flowId: string; condition: ProtectedHoldCondition }[] = [];
    let attention = 0;
    for (const row of rows) {
      const condition = this.conditionOf(row, credentialsMissing);
      if (!condition) continue;
      attention += 1;
      if (await this.flag(row, condition)) flagged.push({ reservationId: row.reservation_id, flowId: row.flow_id, condition });
    }
    this.metrics.attention = attention;
    return flagged;
  }

  private conditionOf(row: HoldRow, credentialsMissing: boolean): ProtectedHoldCondition | null {
    if (!row.flow_exists || row.withdrawal_id === null) return ProtectedHoldCondition.ORPHAN;
    if (row.completed || !['RESERVED', 'SUBMITTING', 'PROCESSING'].includes(row.state as string)) return ProtectedHoldCondition.TERMINAL_FLOW;
    if (credentialsMissing) return ProtectedHoldCondition.CREDENTIALS_MISSING;
    if (row.unscheduled) return ProtectedHoldCondition.NO_RECOVERABLE_SCHEDULE;
    if (row.overdue) return ProtectedHoldCondition.OVERDUE;
    return null;
  }

  /** Review + audit + outbox + metric, once per (hold, condition). Returns false when already paged. */
  private async flag(row: HoldRow, condition: ProtectedHoldCondition): Promise<boolean> {
    return this.unitOfWork.run(async (manager) => {
      const [already] = (await manager.query(
        `SELECT 1 FROM audit_logs
          WHERE subject_type = 'FLOW' AND subject_id = $1 AND action = 'PROTECTED_HOLD_FLAGGED'
            AND after ->> 'reservationId' = $2 AND after ->> 'holdCondition' = $3
          LIMIT 1`,
        [row.flow_id, row.reservation_id, condition],
      )) as unknown[];
      if (already) return false;
      if (row.withdrawal_id !== null) {
        await openReview(
          manager,
          { table: 'paystack_withdrawals', flowId: row.withdrawal_id },
          { reason: WithdrawalReviewReason.PROTECTED_HOLD_OVERDUE, actor: MONITOR_ACTOR },
        );
      }
      await this.audit.record({
        actor: { type: 'SYSTEM' },
        action: AuditAction.PROTECTED_HOLD_FLAGGED,
        subject: { type: AuditSubjectType.FLOW, id: row.flow_id },
        after: { reservationId: row.reservation_id, holdCondition: condition, ...(row.state ? { flowState: row.state } : {}) },
        reason: `protected payout hold needs attention (${condition}); it stays held — never released by the monitor`,
      });
      const payload: ProtectedHoldFlaggedPayload = { reservationId: row.reservation_id, flowId: row.flow_id, condition };
      await this.outbox.enqueue(OutboxEventType.PROTECTED_HOLD_FLAGGED, row.flow_id, payload);
      this.metrics.flagged(condition);
      this.logger.error({ reservationId: row.reservation_id, flowId: row.flow_id, condition }, 'Protected payout hold needs attention (paged)');
      return true;
    });
  }
}
