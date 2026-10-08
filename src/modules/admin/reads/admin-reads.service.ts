import { Injectable } from '@nestjs/common';
import { ValidationError } from '../../../common/errors';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { microsecondsToTimestamp, timestampToMicroseconds } from '../../transactions/history-time';
import { BREAK_POLICIES, BREAK_TYPES, BreakSeverity, BreakType } from '../../reconciliation/break-types';
import { BreakStatus } from '../../reconciliation/break-transitions';
import { ReconciliationBreakNotFoundError } from '../../reconciliation/reconciliation.errors';
import { UserRole } from '../../users/user.types';
import { ReconciliationRunNotFoundError, UserNotFoundError } from '../admin.errors';
import { ApprovalRepository } from '../approvals/approval.repository';
import { ApprovalView, toApprovalView } from '../approvals/approval.view';
import { AdminPage, AdminPosition, decodeAdminCursor, filterFingerprint, toPage } from './admin-cursor';
import { AuditTrailEntry, AuditTrailReader } from './audit-trail.reader';

export interface BreakView {
  readonly breakId: string;
  readonly type: string;
  readonly severity: BreakSeverity;
  readonly status: string;
  readonly subjectKey: string;
  readonly currency: string | null;
  readonly amount: string;
  readonly firstDetectedAt: string;
  readonly lastDetectedAt: string;
  readonly escalatedAt: string | null;
  readonly resolvedAt: string | null;
  readonly resolutionKind: string | null;
  readonly resolutionReference: string | null;
  readonly resolvedBy: string | null;
  readonly note: string | null;
  /** Evidence, by id: what the break points at. */
  readonly evidence: {
    readonly flowId: string | null;
    readonly providerPaymentId: string | null;
    readonly settlementBatchId: string | null;
    readonly settlementBatchLineId: string | null;
    readonly webhookEventId: string | null;
    readonly ledgerAccountId: string | null;
    readonly detectedByRunId: string;
    readonly lastDetectedRunId: string;
    readonly previousBreakId: string | null;
    readonly details: Record<string, unknown>;
  };
}

export interface FindingView {
  readonly runId: string;
  readonly kind: string;
  readonly currency: string | null;
  readonly subject: string;
  readonly measured: Record<string, unknown>;
  readonly drift: string;
  readonly breakId: string | null;
  readonly recordedAt: string;
}

export interface BreakDetailView extends BreakView {
  readonly findings: readonly FindingView[];
  readonly approvals: readonly ApprovalView[];
  readonly trail: readonly AuditTrailEntry[];
}

export interface RunView {
  readonly runId: string;
  readonly kind: string;
  readonly periodKey: string;
  readonly status: string;
  readonly attempts: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly snapshotAt: string | null;
  readonly summary: Record<string, unknown>;
  readonly lastError: string | null;
}

export interface RunDetailView extends RunView {
  readonly findings: readonly FindingView[];
  readonly breaksDetected: number;
}

export interface BreakFilter {
  /** `LIVE` = OPEN or ESCALATED. */
  readonly status: BreakStatus | 'LIVE' | null;
  readonly type: BreakType | null;
  readonly severity: BreakSeverity | null;
  readonly currency: string | null;
}

export interface RecertificationEntry {
  readonly userId: string;
  readonly role: string;
  readonly status: string;
  readonly since: string;
  readonly grantedBy: string | null;
  readonly grantApprovalId: string | null;
  readonly bootstrap: boolean;
  /** The last session the holder started (a refresh family): standing privilege nobody uses is drift too. */
  readonly lastSessionStartedAt: string | null;
}

export interface RecertificationReport {
  readonly generatedAt: string;
  readonly holders: readonly RecertificationEntry[];
  /** Privileged roles on `users` with no live assignment record (or the reverse): must be empty. */
  readonly discrepancies: readonly { readonly userId: string; readonly role: string; readonly problem: string }[];
}

export interface AdminUserView {
  readonly userId: string;
  readonly status: string;
  readonly role: string;
  readonly createdAt: string;
  readonly verifiedAt: string | null;
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

interface BreakRow {
  id: string;
  type: BreakType;
  status: string;
  subject_key: string;
  currency_code: string | null;
  amount_minor: string;
  first_detected_at: Date;
  last_detected_at: Date;
  escalated_at: Date | null;
  resolved_at: Date | null;
  resolution_kind: string | null;
  resolution_reference: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  flow_id: string | null;
  provider_payment_id: string | null;
  settlement_batch_id: string | null;
  settlement_batch_line_id: string | null;
  webhook_event_id: string | null;
  ledger_account_id: string | null;
  detected_by_run_id: string;
  last_detected_run_id: string;
  previous_break_id: string | null;
  details: Record<string, unknown>;
  sort_micros: string;
}

const BREAK_COLUMNS = `reconciliation_breaks.id, reconciliation_breaks.type, reconciliation_breaks.status, reconciliation_breaks.subject_key,
  reconciliation_breaks.currency_code, reconciliation_breaks.amount_minor::text AS amount_minor, reconciliation_breaks.first_detected_at,
  reconciliation_breaks.last_detected_at, reconciliation_breaks.escalated_at, reconciliation_breaks.resolved_at,
  reconciliation_breaks.resolution_kind, reconciliation_breaks.resolution_reference, reconciliation_breaks.resolved_by,
  reconciliation_breaks.resolution_note, reconciliation_breaks.flow_id, reconciliation_breaks.provider_payment_id,
  reconciliation_breaks.settlement_batch_id, reconciliation_breaks.settlement_batch_line_id, reconciliation_breaks.webhook_event_id,
  reconciliation_breaks.ledger_account_id, reconciliation_breaks.detected_by_run_id, reconciliation_breaks.last_detected_run_id,
  reconciliation_breaks.previous_break_id, reconciliation_breaks.details,
  ${timestampToMicroseconds('reconciliation_breaks.first_detected_at')} AS sort_micros`;

function toBreakView(row: BreakRow): BreakView {
  return {
    breakId: row.id,
    type: row.type,
    severity: BREAK_POLICIES[row.type].severity,
    status: row.status,
    subjectKey: row.subject_key,
    currency: row.currency_code?.trim() ?? null,
    amount: row.amount_minor,
    firstDetectedAt: row.first_detected_at.toISOString(),
    lastDetectedAt: row.last_detected_at.toISOString(),
    escalatedAt: iso(row.escalated_at),
    resolvedAt: iso(row.resolved_at),
    resolutionKind: row.resolution_kind,
    resolutionReference: row.resolution_reference,
    resolvedBy: row.resolved_by,
    note: row.resolution_note,
    evidence: {
      flowId: row.flow_id,
      providerPaymentId: row.provider_payment_id,
      settlementBatchId: row.settlement_batch_id,
      settlementBatchLineId: row.settlement_batch_line_id,
      webhookEventId: row.webhook_event_id,
      ledgerAccountId: row.ledger_account_id,
      detectedByRunId: row.detected_by_run_id,
      lastDetectedRunId: row.last_detected_run_id,
      previousBreakId: row.previous_break_id,
      details: row.details,
    },
  };
}

interface RunRow {
  id: string;
  kind: string;
  period_key: string;
  status: string;
  attempts: number;
  started_at: Date;
  finished_at: Date | null;
  snapshot_at: Date | null;
  summary: Record<string, unknown>;
  last_error: string | null;
  sort_micros: string;
}

const RUN_COLUMNS = `reconciliation_runs.id, reconciliation_runs.kind, reconciliation_runs.period_key, reconciliation_runs.status,
  reconciliation_runs.attempts, reconciliation_runs.started_at, reconciliation_runs.finished_at, reconciliation_runs.snapshot_at,
  reconciliation_runs.summary, reconciliation_runs.last_error, ${timestampToMicroseconds('reconciliation_runs.started_at')} AS sort_micros`;

function toRunView(row: RunRow): RunView {
  return {
    runId: row.id,
    kind: row.kind,
    periodKey: row.period_key,
    status: row.status,
    attempts: row.attempts,
    startedAt: row.started_at.toISOString(),
    finishedAt: iso(row.finished_at),
    snapshotAt: iso(row.snapshot_at),
    summary: row.summary,
    lastError: row.last_error,
  };
}

interface FindingRow {
  run_id: string;
  kind: string;
  currency_code: string | null;
  subject: string;
  measured: Record<string, unknown>;
  drift_minor: string;
  break_id: string | null;
  created_at: Date;
}

const toFindingView = (row: FindingRow): FindingView => ({
  runId: row.run_id,
  kind: row.kind,
  currency: row.currency_code?.trim() ?? null,
  subject: row.subject,
  measured: row.measured,
  drift: row.drift_minor,
  breakId: row.break_id,
  recordedAt: row.created_at.toISOString(),
});

const FINDING_COLUMNS = `run_id, kind, currency_code, subject, measured, drift_minor::text AS drift_minor, break_id, created_at`;

/**
 * The admin read models (design §12; Phase 10 plan §E.9): breaks and runs with their evidence, recertification
 * (design §9.3), a user's account state. Read-only, keyset-paginated where a list can grow, ids and codes only.
 */
@Injectable()
export class AdminReadsService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly approvals: ApprovalRepository,
    private readonly trail: AuditTrailReader,
  ) {}

  async breaks(filter: BreakFilter, cursor: string | undefined, limit: number): Promise<AdminPage<BreakView>> {
    const fingerprint = filterFingerprint('breaks', { ...filter });
    const position = cursor ? decodeAdminCursor(cursor, fingerprint) : null;
    const types = filter.severity ? BREAK_TYPES.filter((type) => BREAK_POLICIES[type].severity === filter.severity) : null;
    const rows = (await this.unitOfWork.manager.query(
      `SELECT ${BREAK_COLUMNS} FROM reconciliation_breaks
        WHERE ($1::text IS NULL OR ($1 = 'LIVE' AND reconciliation_breaks.status <> 'RESOLVED')
                                OR reconciliation_breaks.status::text = $1)
          AND ($2::reconciliation_break_type IS NULL OR reconciliation_breaks.type = $2::reconciliation_break_type)
          AND ($3::reconciliation_break_type[] IS NULL OR reconciliation_breaks.type = ANY($3::reconciliation_break_type[]))
          AND ($4::text IS NULL OR reconciliation_breaks.currency_code = $4)
          AND ($5::bigint IS NULL OR (reconciliation_breaks.first_detected_at, reconciliation_breaks.id) < (${microsecondsToTimestamp('$5')}, $6::uuid))
        ORDER BY reconciliation_breaks.first_detected_at DESC, reconciliation_breaks.id DESC
        LIMIT $7`,
      [filter.status, filter.type, types, filter.currency, position?.micros.toString() ?? null, position?.id ?? null, limit + 1],
    )) as BreakRow[];
    return toPage(rows.map((row) => ({ item: toBreakView(row), position: positionOf(row) })), limit, fingerprint);
  }

  async breakDetail(breakId: string): Promise<BreakDetailView> {
    const [row] = (await this.unitOfWork.manager.query(`SELECT ${BREAK_COLUMNS} FROM reconciliation_breaks WHERE reconciliation_breaks.id = $1`, [
      breakId,
    ])) as BreakRow[];
    if (!row) throw new ReconciliationBreakNotFoundError(breakId);
    const findings = (await this.unitOfWork.manager.query(
      `SELECT ${FINDING_COLUMNS} FROM reconciliation_findings WHERE break_id = $1 ORDER BY created_at, id`,
      [breakId],
    )) as FindingRow[];
    return {
      ...toBreakView(row),
      findings: findings.map(toFindingView),
      approvals: (await this.approvals.forBreak(breakId)).map(toApprovalView),
      trail: await this.trail.forSubject(breakId),
    };
  }

  async runs(kind: string | null, cursor: string | undefined, limit: number): Promise<AdminPage<RunView>> {
    const fingerprint = filterFingerprint('runs', { kind });
    const position = cursor ? decodeAdminCursor(cursor, fingerprint) : null;
    const rows = (await this.unitOfWork.manager.query(
      `SELECT ${RUN_COLUMNS} FROM reconciliation_runs
        WHERE ($1::reconciliation_run_kind IS NULL OR reconciliation_runs.kind = $1::reconciliation_run_kind)
          AND ($2::bigint IS NULL OR (reconciliation_runs.started_at, reconciliation_runs.id) < (${microsecondsToTimestamp('$2')}, $3::uuid))
        ORDER BY reconciliation_runs.started_at DESC, reconciliation_runs.id DESC
        LIMIT $4`,
      [kind, position?.micros.toString() ?? null, position?.id ?? null, limit + 1],
    )) as RunRow[];
    return toPage(rows.map((row) => ({ item: toRunView(row), position: positionOf(row) })), limit, fingerprint);
  }

  async runDetail(runId: string): Promise<RunDetailView> {
    const [row] = (await this.unitOfWork.manager.query(`SELECT ${RUN_COLUMNS} FROM reconciliation_runs WHERE reconciliation_runs.id = $1`, [
      runId,
    ])) as RunRow[];
    if (!row) throw new ReconciliationRunNotFoundError(runId);
    const findings = (await this.unitOfWork.manager.query(
      `SELECT ${FINDING_COLUMNS} FROM reconciliation_findings WHERE run_id = $1 ORDER BY id`,
      [runId],
    )) as FindingRow[];
    const [detected] = (await this.unitOfWork.manager.query(`SELECT count(*)::int AS count FROM reconciliation_breaks WHERE detected_by_run_id = $1`, [
      runId,
    ])) as { count: number }[];
    return { ...toRunView(row), findings: findings.map(toFindingView), breaksDetected: detected.count };
  }

  /**
   * Recertification (design §9.3; handbook: access control — "review access periodically"): who holds a
   * privileged role, since when, granted by whom, through which approval (or the one-time bootstrap). A
   * privileged role on `users` without its live assignment (or the reverse) is listed as a discrepancy: the
   * report must reconcile with itself.
   */
  async recertification(): Promise<RecertificationReport> {
    const holders = (await this.unitOfWork.manager.query(
      `SELECT role_assignments.user_id, role_assignments.role, users.status, role_assignments.granted_at, role_assignments.granted_by,
              role_assignments.grant_approval_id, role_assignments.is_bootstrap,
              (SELECT max(refresh_token_families.created_at) FROM refresh_token_families
                WHERE refresh_token_families.user_id = role_assignments.user_id) AS last_session_started_at
         FROM role_assignments JOIN users ON users.id = role_assignments.user_id
        WHERE role_assignments.revoked_at IS NULL
        ORDER BY role_assignments.role, role_assignments.granted_at, role_assignments.user_id`,
    )) as {
      user_id: string;
      role: string;
      status: string;
      granted_at: Date;
      granted_by: string | null;
      grant_approval_id: string | null;
      is_bootstrap: boolean;
      last_session_started_at: Date | null;
    }[];
    const discrepancies = (await this.unitOfWork.manager.query(
      `SELECT users.id AS user_id, users.role::text AS role, 'ROLE_WITHOUT_ASSIGNMENT' AS problem
         FROM users
        WHERE users.role <> 'USER'
          AND NOT EXISTS (SELECT 1 FROM role_assignments
                           WHERE role_assignments.user_id = users.id AND role_assignments.revoked_at IS NULL AND role_assignments.role = users.role)
       UNION ALL
       SELECT role_assignments.user_id, role_assignments.role::text, 'ASSIGNMENT_WITHOUT_ROLE'
         FROM role_assignments JOIN users ON users.id = role_assignments.user_id
        WHERE role_assignments.revoked_at IS NULL AND users.role <> role_assignments.role
        ORDER BY 1, 2`,
    )) as { user_id: string; role: string; problem: string }[];
    const [now] = (await this.unitOfWork.manager.query(`SELECT now() AS now`)) as { now: Date }[];
    return {
      generatedAt: now.now.toISOString(),
      holders: holders.map((row) => ({
        userId: row.user_id,
        role: row.role,
        status: row.status,
        since: row.granted_at.toISOString(),
        grantedBy: row.granted_by,
        grantApprovalId: row.grant_approval_id,
        bootstrap: row.is_bootstrap,
        lastSessionStartedAt: iso(row.last_session_started_at),
      })),
      discrepancies: discrepancies.map((row) => ({ userId: row.user_id, role: row.role, problem: row.problem })),
    };
  }

  /** A user's account state for an administrator: ids, status, role — no email (design §9.5; plan §E.9). */
  async user(userId: string): Promise<AdminUserView> {
    const [row] = (await this.unitOfWork.manager.query(`SELECT id, status, role, created_at, verified_at FROM users WHERE id = $1`, [userId])) as {
      id: string;
      status: string;
      role: UserRole;
      created_at: Date;
      verified_at: Date | null;
    }[];
    if (!row) throw new UserNotFoundError(userId);
    return { userId: row.id, status: row.status, role: row.role, createdAt: row.created_at.toISOString(), verifiedAt: iso(row.verified_at) };
  }
}

function positionOf(row: { id: string; sort_micros: string }): AdminPosition {
  return { micros: BigInt(row.sort_micros), id: row.id };
}

export function parseBreakStatusFilter(raw: string | undefined): BreakStatus | 'LIVE' | null {
  if (raw === undefined) return null;
  if (raw === 'LIVE' || (Object.values(BreakStatus) as string[]).includes(raw)) return raw as BreakStatus | 'LIVE';
  throw new ValidationError('status must be LIVE, OPEN, ESCALATED or RESOLVED.', { status: raw });
}
