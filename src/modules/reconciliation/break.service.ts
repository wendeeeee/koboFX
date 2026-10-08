import { Injectable, Logger } from '@nestjs/common';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { AuditAction, AuditActor, AuditLogService, AuditSubjectType } from '../audit/audit-log.service';
import { OutboxService } from '../outbox/outbox.service';
import { OutboxEventType, ReconciliationBreakChangedPayload } from '../outbox/outbox.types';
import { BREAK_POLICIES, BreakType } from './break-types';
import { BreakStatus, ResolutionKind, assertBreakTransition } from './break-transitions';
import { ReconciliationBreakNotFoundError } from './reconciliation.errors';
import { DetectedDiscrepancy } from './settlement-matcher';

export interface BreakCandidate extends DetectedDiscrepancy {
  readonly settlementBatchId?: string;
  readonly settlementBatchLineId?: string;
  readonly webhookEventId?: string;
  readonly ledgerAccountId?: string;
}

export interface ReconciliationBreak {
  readonly id: string;
  readonly type: BreakType;
  readonly subjectKey: string;
  readonly status: BreakStatus;
  readonly currency: string | null;
  readonly amountMinor: bigint;
  readonly details: Record<string, unknown>;
  readonly flowId: string | null;
  readonly providerPaymentId: string | null;
  readonly settlementBatchId: string | null;
  readonly settlementBatchLineId: string | null;
  readonly webhookEventId: string | null;
  readonly ledgerAccountId: string | null;
  readonly detectedByRunId: string;
  readonly lastDetectedRunId: string;
  readonly previousBreakId: string | null;
  readonly resolutionKind: ResolutionKind | null;
  readonly resolutionReference: string | null;
  readonly resolvedBy: string | null;
  readonly resolutionNote: string | null;
}

export interface Detection {
  readonly breakId: string;
  readonly created: boolean;
  readonly status: BreakStatus;
}

interface BreakRow {
  id: string;
  type: BreakType;
  subject_key: string;
  status: BreakStatus;
  currency_code: string | null;
  amount_minor: string;
  details: Record<string, unknown>;
  flow_id: string | null;
  provider_payment_id: string | null;
  settlement_batch_id: string | null;
  settlement_batch_line_id: string | null;
  webhook_event_id: string | null;
  ledger_account_id: string | null;
  detected_by_run_id: string;
  last_detected_run_id: string;
  previous_break_id: string | null;
  resolution_kind: ResolutionKind | null;
  resolution_reference: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

const COLUMNS = `id, type, subject_key, status, currency_code, amount_minor::text AS amount_minor, details, flow_id,
  provider_payment_id, settlement_batch_id, settlement_batch_line_id, webhook_event_id, ledger_account_id,
  detected_by_run_id, last_detected_run_id, previous_break_id, resolution_kind, resolution_reference, resolved_by,
  resolution_note`;
const ACTOR_PATTERN = /^(job|operator):.+$/;
const MAXIMUM_NOTE_LENGTH = 500;

function toBreak(row: BreakRow): ReconciliationBreak {
  return {
    id: row.id,
    type: row.type,
    subjectKey: row.subject_key,
    status: row.status,
    currency: row.currency_code,
    amountMinor: BigInt(row.amount_minor),
    details: row.details,
    flowId: row.flow_id,
    providerPaymentId: row.provider_payment_id,
    settlementBatchId: row.settlement_batch_id,
    settlementBatchLineId: row.settlement_batch_line_id,
    webhookEventId: row.webhook_event_id,
    ledgerAccountId: row.ledger_account_id,
    detectedByRunId: row.detected_by_run_id,
    lastDetectedRunId: row.last_detected_run_id,
    previousBreakId: row.previous_break_id,
    resolutionKind: row.resolution_kind,
    resolutionReference: row.resolution_reference,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
  };
}

function auditActorOf(by: string): AuditActor {
  return by.startsWith('operator:') ? { type: 'OPERATOR', id: by.slice('operator:'.length) } : { type: 'SYSTEM' };
}


@Injectable()
export class BreakService {
  private readonly logger = new Logger(BreakService.name);

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditLogService,
    private readonly outbox: OutboxService,
  ) {}

  async detect(runId: string, candidate: BreakCandidate): Promise<Detection> {
    const policy = BREAK_POLICIES[candidate.type];
    const initialStatus = policy.escalateOnDetection ? BreakStatus.ESCALATED : BreakStatus.OPEN;
    return this.unitOfWork.run(async (manager) => {
      const [row] = (await manager.query(
        `WITH previous AS (
           SELECT id FROM reconciliation_breaks
            WHERE type = $1 AND subject_key = $2 AND status = 'RESOLVED'
            ORDER BY resolved_at DESC, id DESC LIMIT 1
         )
         INSERT INTO reconciliation_breaks
           (type, subject_key, status, currency_code, amount_minor, details, flow_id, provider_payment_id,
            settlement_batch_id, settlement_batch_line_id, webhook_event_id, ledger_account_id,
            detected_by_run_id, last_detected_run_id, previous_break_id, escalated_at)
         -- A currency we do not hold (a PSP report in CHF) is kept in the details, not as a currency.
         VALUES ($1, $2, $3::reconciliation_break_status, (SELECT code FROM currencies WHERE code = $4::text), $5, $6, $7, $8,
                 $9, $10, $11, $12, $13, $13,
                 (SELECT id FROM previous), CASE WHEN $3::reconciliation_break_status = 'ESCALATED' THEN now() END)
         ON CONFLICT (type, subject_key) WHERE status <> 'RESOLVED'
         DO UPDATE SET last_detected_run_id = EXCLUDED.last_detected_run_id, last_detected_at = now(), updated_at = now()
         RETURNING id, status, (xmax = 0) AS inserted`,
        [
          candidate.type,
          candidate.subjectKey,
          initialStatus,
          candidate.currency,
          candidate.amountMinor.toString(),
          JSON.stringify(candidate.details),
          candidate.flowId ?? null,
          candidate.providerPaymentId ?? null,
          candidate.settlementBatchId ?? null,
          candidate.settlementBatchLineId ?? null,
          candidate.webhookEventId ?? null,
          candidate.ledgerAccountId ?? null,
          runId,
        ],
      )) as { id: string; status: BreakStatus; inserted: boolean }[];
      if (row.inserted) {
        await this.recordChange(row.id, candidate.type, row.status, AuditAction.RECONCILIATION_BREAK_DETECTED, 'job:reconciliation', {
          reason: `${candidate.type} detected (${policy.severity})${row.status === BreakStatus.ESCALATED ? '; escalated: needs a human' : ''}`,
        });
        this.logger.warn(
          {
            breakId: row.id,
            breakType: candidate.type,
            status: row.status,
            currency: candidate.currency,
            amountMinor: candidate.amountMinor.toString(),
            flowId: candidate.flowId,
            providerPaymentId: candidate.providerPaymentId,
            severity: policy.severity,
          },
          'Reconciliation break detected',
        );
      }
      return { breakId: row.id, created: row.inserted, status: row.status };
    });
  }

 
  async detectAndRecord(runId: string, candidate: BreakCandidate): Promise<Detection> {
    return this.unitOfWork.run(async (manager) => {
      const detection = await this.detect(runId, candidate);
      await manager.query(
        `INSERT INTO reconciliation_findings (run_id, kind, currency_code, subject, measured, drift_minor, break_id)
         VALUES ($1, $2, (SELECT code FROM currencies WHERE code = $3::text), $4, $5, $6, $7)`,
        [
          runId,
          candidate.type,
          candidate.currency,
          candidate.subjectKey,
          JSON.stringify(candidate.details),
          BREAK_POLICIES[candidate.type].severity === 'MONEY' ? candidate.amountMinor.toString() : '0',
          detection.breakId,
        ],
      );
      return detection;
    });
  }

  async escalate(breakId: string, by: string, note: string): Promise<boolean> {
    return this.unitOfWork.run(async (manager) => {
      const current = await this.lock(breakId);
      if (current.status !== BreakStatus.OPEN) return false;
      assertBreakTransition(current.status, BreakStatus.ESCALATED);
      await manager.query(
        `UPDATE reconciliation_breaks SET status = 'ESCALATED', escalated_at = now(), resolution_note = $2, updated_at = now()
          WHERE id = $1`,
        [breakId, note.slice(0, MAXIMUM_NOTE_LENGTH)],
      );
      await this.recordChange(breakId, current.type, BreakStatus.ESCALATED, AuditAction.RECONCILIATION_BREAK_ESCALATED, by, {
        before: current.status,
        reason: note,
      });
      return true;
    });
  }


  async annotate(breakId: string, note: string): Promise<void> {
    await this.unitOfWork.manager.query(
      `UPDATE reconciliation_breaks SET resolution_note = $2, updated_at = now() WHERE id = $1 AND status <> 'RESOLVED'`,
      [breakId, note.slice(0, MAXIMUM_NOTE_LENGTH)],
    );
  }

  async resolve(breakId: string, by: string, kind: ResolutionKind, reference: string, note: string): Promise<boolean> {
    if (!ACTOR_PATTERN.test(by)) throw new Error(`A break is resolved by 'job:{name}' or 'operator:{id}', not ${JSON.stringify(by)}.`);
    if (reference.length === 0) throw new Error('A resolution needs a reference.');
    return this.unitOfWork.run(async (manager) => {
      const current = await this.lock(breakId);
      if (current.status === BreakStatus.RESOLVED) return false;
      assertBreakTransition(current.status, BreakStatus.RESOLVED);
      await manager.query(
        `UPDATE reconciliation_breaks
            SET status = 'RESOLVED', resolved_at = now(), resolution_kind = $2, resolution_reference = $3, resolved_by = $4,
                resolution_note = $5, updated_at = now()
          WHERE id = $1`,
        [breakId, kind, reference, by, note.slice(0, MAXIMUM_NOTE_LENGTH)],
      );
      await this.recordChange(breakId, current.type, BreakStatus.RESOLVED, AuditAction.RECONCILIATION_BREAK_RESOLVED, by, {
        before: current.status,
        resolutionKind: kind,
        reason: `${kind}: ${note}`,
      });
      this.logger.log({ breakId, breakType: current.type, resolutionKind: kind, resolutionReference: reference }, 'Reconciliation break resolved');
      return true;
    });
  }

  async findById(breakId: string): Promise<ReconciliationBreak | null> {
    const [row] = (await this.unitOfWork.manager.query(`SELECT ${COLUMNS} FROM reconciliation_breaks WHERE id = $1`, [breakId])) as BreakRow[];
    return row ? toBreak(row) : null;
  }

  async findLive(type: BreakType, subjectKey: string): Promise<ReconciliationBreak | null> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT ${COLUMNS} FROM reconciliation_breaks WHERE type = $1 AND subject_key = $2 AND status <> 'RESOLVED'`,
      [type, subjectKey],
    )) as BreakRow[];
    return row ? toBreak(row) : null;
  }

  async live(types?: readonly BreakType[]): Promise<ReconciliationBreak[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT ${COLUMNS} FROM reconciliation_breaks
        WHERE status <> 'RESOLVED' AND ($1::reconciliation_break_type[] IS NULL OR type = ANY($1::reconciliation_break_type[]))
        ORDER BY first_detected_at, id`,
      [types ? [...types] : null],
    )) as BreakRow[];
    return rows.map(toBreak);
  }

  private async lock(breakId: string): Promise<ReconciliationBreak> {
    const [row] = (await this.unitOfWork
      .requireTransaction()
      .query(`SELECT ${COLUMNS} FROM reconciliation_breaks WHERE id = $1 FOR UPDATE`, [breakId])) as BreakRow[];
    if (!row) throw new ReconciliationBreakNotFoundError(breakId);
    return toBreak(row);
  }

  private async recordChange(
    breakId: string,
    type: BreakType,
    status: BreakStatus,
    action: AuditAction,
    by: string,
    change: { before?: BreakStatus; resolutionKind?: ResolutionKind; reason: string },
  ): Promise<void> {
    await this.audit.record({
      actor: auditActorOf(by),
      action,
      subject: { type: AuditSubjectType.RECONCILIATION_BREAK, id: breakId },
      ...(change.before ? { before: { breakType: type, breakStatus: change.before } } : {}),
      after: { breakType: type, breakStatus: status, ...(change.resolutionKind ? { resolutionKind: change.resolutionKind } : {}) },
      reason: change.reason,
    });
    const payload: ReconciliationBreakChangedPayload = { breakId, type, status };
    await this.outbox.enqueue(OutboxEventType.RECONCILIATION_BREAK_CHANGED, breakId, payload);
  }
}
