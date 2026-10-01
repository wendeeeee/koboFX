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
  readonly periodKey: string;
  readonly status: ReconciliationRunStatus;
  readonly attempts: number;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly summary: Record<string, unknown>;
  readonly lastError: string | null;
}

/** A run this worker holds the lease on; `leaseToken` fences every write that finishes it. */
export interface ClaimedRun extends ReconciliationRun {
  readonly leaseToken: string;
}

interface RunRow {
  id: string;
  kind: ReconciliationRunKind;
  period_key: string;
  status: ReconciliationRunStatus;
  attempts: number;
  started_at: Date;
  finished_at: Date | null;
  summary: Record<string, unknown>;
  last_error: string | null;
  lease_token: string | null;
}

const COLUMNS = `reconciliation_runs.id, reconciliation_runs.kind, reconciliation_runs.period_key, reconciliation_runs.status,
  reconciliation_runs.attempts, reconciliation_runs.started_at, reconciliation_runs.finished_at, reconciliation_runs.summary,
  reconciliation_runs.last_error, reconciliation_runs.lease_token`;
const MAXIMUM_ERROR_LENGTH = 500;

function toRun(row: RunRow): ReconciliationRun {
  return {
    id: row.id,
    kind: row.kind,
    periodKey: row.period_key,
    status: row.status,
    attempts: row.attempts,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    summary: row.summary,
    lastError: row.last_error,
  };
}

/**
 * `reconciliation_runs`: one run per `(kind, period)`, claimed like a flow.
 *
 * - `claim` inserts the run (`ON CONFLICT DO NOTHING`); if it already exists, RUNNING, and its
 *   lease has lapsed (a dead worker), the claim takes it over — the run is RESUMED, and every
 *   step it re-runs is idempotent. Two workers never both hold one run.
 * - `finish` and `release` are fenced by the lease token.
 */
@Injectable()
export class ReconciliationRunRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async claim(kind: ReconciliationRunKind, periodKey: string, leaseSeconds: number): Promise<ClaimedRun | null> {
    const manager = this.unitOfWork.manager;
    const [inserted] = (await manager.query(
      `INSERT INTO reconciliation_runs (kind, period_key, status, attempts, leased_until, lease_token)
       VALUES ($1, $2, 'RUNNING', 1, now() + make_interval(secs => $3), gen_random_uuid())
       ON CONFLICT (kind, (COALESCE(provider, '')), period_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [kind, periodKey, leaseSeconds],
    )) as RunRow[];
    if (inserted) return { ...toRun(inserted), leaseToken: inserted.lease_token as string };
    const [resumed] = (await manager.query(
      `WITH target AS (
         SELECT id FROM reconciliation_runs
          WHERE kind = $1 AND period_key = $2 AND status = 'RUNNING'
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
      [kind, periodKey, leaseSeconds],
    )) as RunRow[];
    return resumed ? { ...toRun(resumed), leaseToken: resumed.lease_token as string } : null;
  }

  /** Periods left RUNNING by a dead worker (lease lapsed), oldest first: resumed before new work. */
  async abandonedPeriods(kind: ReconciliationRunKind): Promise<string[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT period_key FROM reconciliation_runs
        WHERE kind = $1 AND status = 'RUNNING' AND (leased_until IS NULL OR leased_until < now())
        ORDER BY period_key`,
      [kind],
    )) as { period_key: string }[];
    return rows.map((row) => row.period_key);
  }

  /** Keep the lease while a long run works (fenced). */
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

  /** Finish the run (fenced, in the ambient transaction when there is one). */
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

  /** Give the lease back after a failure; the run stays RUNNING and is resumed on a later tick. */
  async release(run: ClaimedRun, error: string): Promise<void> {
    await this.unitOfWork.manager.query(
      `UPDATE reconciliation_runs SET leased_until = NULL, lease_token = NULL, last_error = $3
        WHERE id = $1 AND lease_token = $2 AND status = 'RUNNING'`,
      [run.id, run.leaseToken, error.slice(0, MAXIMUM_ERROR_LENGTH)],
    );
  }

  /** A period nobody ran, recorded so the gap is explicit (never "clean"). */
  async recordMissed(kind: ReconciliationRunKind, periodKey: string): Promise<void> {
    await this.unitOfWork.manager.query(
      `INSERT INTO reconciliation_runs (kind, period_key, status, finished_at, summary)
       VALUES ($1, $2, 'MISSED', now(), '{"reason":"no run in this period"}')
       ON CONFLICT (kind, (COALESCE(provider, '')), period_key) DO NOTHING`,
      [kind, periodKey],
    );
  }

  /** The latest period of this kind that has a row (run, running or missed). */
  async latestPeriod(kind: ReconciliationRunKind): Promise<string | null> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT period_key FROM reconciliation_runs WHERE kind = $1 ORDER BY period_key DESC LIMIT 1`,
      [kind],
    )) as { period_key: string }[];
    return row?.period_key ?? null;
  }

  async find(kind: ReconciliationRunKind, periodKey: string): Promise<ReconciliationRun | null> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT ${COLUMNS} FROM reconciliation_runs WHERE kind = $1 AND period_key = $2`,
      [kind, periodKey],
    )) as RunRow[];
    return row ? toRun(row) : null;
  }
}
