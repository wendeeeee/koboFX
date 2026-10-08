import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { ReconciliationRunLeaseLostError } from './reconciliation.errors';
import { ReconciliationRunKind } from './reconciliation-schedule';

export enum ReconciliationRunStatus {
  RUNNING = 'RUNNING',
  CLEAN = 'CLEAN',
  BREAKS_FOUND = 'BREAKS_FOUND',
  MISSED = 'MISSED',
}

export interface ReconciliationRun {
  readonly id: string;
  readonly kind: ReconciliationRunKind;
  readonly provider: string | null;
  readonly periodKey: string;
  readonly status: ReconciliationRunStatus;
  readonly attempts: number;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly summary: Record<string, unknown>;
  readonly lastError: string | null;
}

export interface ClaimedRun extends ReconciliationRun {
  readonly leaseToken: string;
}

interface RunRow {
  id: string;
  kind: ReconciliationRunKind;
  provider: string | null;
  period_key: string;
  status: ReconciliationRunStatus;
  attempts: number;
  started_at: Date;
  finished_at: Date | null;
  summary: Record<string, unknown>;
  last_error: string | null;
  lease_token: string | null;
}

const COLUMNS = `reconciliation_runs.id, reconciliation_runs.kind, reconciliation_runs.provider, reconciliation_runs.period_key, reconciliation_runs.status,
  reconciliation_runs.attempts, reconciliation_runs.started_at, reconciliation_runs.finished_at, reconciliation_runs.summary,
  reconciliation_runs.last_error, reconciliation_runs.lease_token`;
const MAXIMUM_ERROR_LENGTH = 500;

function toRun(row: RunRow): ReconciliationRun {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    periodKey: row.period_key,
    status: row.status,
    attempts: row.attempts,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    summary: row.summary,
    lastError: row.last_error,
  };
}


@Injectable()
export class ReconciliationRunRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async claim(kind: ReconciliationRunKind, periodKey: string, leaseSeconds: number, provider: string | null = null): Promise<ClaimedRun | null> {
    const manager = this.unitOfWork.manager;
    const [inserted] = (await manager.query(
      `INSERT INTO reconciliation_runs (kind, period_key, status, attempts, leased_until, lease_token, provider)
       VALUES ($1, $2, 'RUNNING', 1, now() + make_interval(secs => $3), gen_random_uuid(), $4)
       ON CONFLICT (kind, (COALESCE(provider, '')), period_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [kind, periodKey, leaseSeconds, provider],
    )) as RunRow[];
    if (inserted) return { ...toRun(inserted), leaseToken: inserted.lease_token as string };
    const [resumed] = (await manager.query(
      `WITH target AS (
         SELECT id FROM reconciliation_runs
          WHERE kind = $1 AND period_key = $2 AND status = 'RUNNING' AND provider IS NOT DISTINCT FROM $4
            AND (leased_until IS NULL OR leased_until < now())
          FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE reconciliation_runs
            SET attempts = reconciliation_runs.attempts + 1, leased_until = now() + make_interval(secs => $3),
                lease_token = gen_random_uuid()
           FROM target WHERE reconciliation_runs.id = target.id
         RETURNING ${COLUMNS}
       )
       SELECT * FROM claimed`,
      [kind, periodKey, leaseSeconds, provider],
    )) as RunRow[];
    return resumed ? { ...toRun(resumed), leaseToken: resumed.lease_token as string } : null;
  }

  async abandonedPeriods(kind: ReconciliationRunKind, provider: string | null = null): Promise<string[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT period_key FROM reconciliation_runs
        WHERE kind = $1 AND provider IS NOT DISTINCT FROM $2 AND status = 'RUNNING' AND (leased_until IS NULL OR leased_until < now())
        ORDER BY period_key`,
      [kind, provider],
    )) as { period_key: string }[];
    return rows.map((row) => row.period_key);
  }

  async heartbeat(run: ClaimedRun, leaseSeconds: number): Promise<void> {
    const rows = (await this.unitOfWork.manager.query(
      `WITH updated AS (
         UPDATE reconciliation_runs SET leased_until = now() + make_interval(secs => $3)
          WHERE id = $1 AND lease_token = $2 AND status = 'RUNNING'
         RETURNING id
       ) SELECT id FROM updated`,
      [run.id, run.leaseToken, leaseSeconds],
    )) as { id: string }[];
    if (rows.length !== 1) throw new ReconciliationRunLeaseLostError(run.id);
  }

  async finish(
    run: ClaimedRun,
    status: ReconciliationRunStatus.CLEAN | ReconciliationRunStatus.BREAKS_FOUND,
    summary: Record<string, unknown>,
    snapshotAt: Date | null,
  ): Promise<void> {
    const rows = (await this.unitOfWork.manager.query(
      `WITH updated AS (
         UPDATE reconciliation_runs
            SET status = $3, summary = $4, snapshot_at = $5, finished_at = now(), leased_until = NULL, lease_token = NULL,
                last_error = NULL
          WHERE id = $1 AND lease_token = $2 AND status = 'RUNNING'
         RETURNING id
       ) SELECT id FROM updated`,
      [run.id, run.leaseToken, status, JSON.stringify(summary), snapshotAt],
    )) as { id: string }[];
    if (rows.length !== 1) throw new ReconciliationRunLeaseLostError(run.id);
  }

  async release(run: ClaimedRun, error: string): Promise<void> {
    await this.unitOfWork.manager.query(
      `UPDATE reconciliation_runs SET leased_until = NULL, lease_token = NULL, last_error = $3
        WHERE id = $1 AND lease_token = $2 AND status = 'RUNNING'`,
      [run.id, run.leaseToken, error.slice(0, MAXIMUM_ERROR_LENGTH)],
    );
  }

  async recordMissed(kind: ReconciliationRunKind, periodKey: string, provider: string | null = null): Promise<void> {
    await this.unitOfWork.manager.query(
      `INSERT INTO reconciliation_runs (kind, period_key, status, finished_at, summary, provider)
       VALUES ($1, $2, 'MISSED', now(), '{"reason":"no run in this period"}', $3)
       ON CONFLICT (kind, (COALESCE(provider, '')), period_key) DO NOTHING`,
      [kind, periodKey, provider],
    );
  }

  async latestPeriod(kind: ReconciliationRunKind, provider: string | null = null): Promise<string | null> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT period_key FROM reconciliation_runs WHERE kind = $1 AND provider IS NOT DISTINCT FROM $2 ORDER BY period_key DESC LIMIT 1`,
      [kind, provider],
    )) as { period_key: string }[];
    return row?.period_key ?? null;
  }

  async find(kind: ReconciliationRunKind, periodKey: string, provider: string | null = null): Promise<ReconciliationRun | null> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT ${COLUMNS} FROM reconciliation_runs WHERE kind = $1 AND period_key = $2 AND provider IS NOT DISTINCT FROM $3`,
      [kind, periodKey, provider],
    )) as RunRow[];
    return row ? toRun(row) : null;
  }
}
