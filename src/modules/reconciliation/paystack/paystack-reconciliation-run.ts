import { DependencyUnavailableError } from '../../../common/errors';
import { BreakType } from '../break-types';
import { BreakCandidate } from '../break.service';
import { ClaimedRun } from '../reconciliation-run.repository';

/**
 * A family of Paystack activity, owned by one component of the composed run (WITHDRAWAL_PLAN.md §I.2). The values are
 * the webhook families' (`PaystackEventFamily`): `charge.*` is funding's, `transfer.*` is withdrawals'.
 */
export enum PaystackReconciliationFamily {
  CHARGE = 'CHARGE',
  TRANSFER = 'TRANSFER',
}

/** What one claimed run has seen so far, shared by every component (one sweep, one finish, after all of them). */
export class Seen {
  readonly detected = new Set<string>();
  readonly resolved = new Set<string>();
  readonly counts: Record<string, number> = {};
  /** Scans that could not be completed (a page cap, an unreadable page…): the run can never finish CLEAN. */
  readonly incomplete: string[] = [];

  note(breakId: string, type: BreakType): void {
    this.detected.add(breakId);
    this.counts[type] = (this.counts[type] ?? 0) + 1;
  }
}

/** Handed to each component: the claimed run, the shared `Seen`, and the run's own break detection and lease. */
export interface ComponentRun {
  readonly run: ClaimedRun;
  readonly seen: Seen;
  /** Detect (or re-detect) a break under this run, and record its finding. Returns the break id. */
  detect(candidate: BreakCandidate): Promise<string>;
  /** Extend the run's lease (long scans call it between pages). */
  heartbeat(): Promise<void>;
}

/**
 * One family's share of the Paystack run. A component never registers itself as a provider reconciliation, never
 * sweeps "no longer detected" and never finishes the run: the composer does each once, after every component ran.
 * Returns counts for the run's summary — the family RAN (its breaks may be swept) — or `null` when the family could
 * not run at all in this configuration (it then proves nothing, and none of its breaks is swept).
 */
export interface PaystackReconciliationComponent {
  readonly family: PaystackReconciliationFamily;
  runDaily(context: ComponentRun): Promise<Record<string, number> | null>;
  runHourly(context: ComponentRun): Promise<Record<string, number> | null>;
}

/**
 * A scan did not complete: absence from it proves nothing, so the run neither sweeps nor finishes. It is released and
 * resumed (every step is idempotent; durable watermarks keep what was covered).
 */
export class ReconciliationScanIncompleteError extends DependencyUnavailableError {
  constructor(runId: string, scans: readonly string[]) {
    super(`Reconciliation run ${runId} could not complete: ${scans.join('; ')}`, { runId, scans: [...scans] });
  }
}
