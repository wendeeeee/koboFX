import { Injectable } from '@nestjs/common';

/** The step boundaries of a reconciliation run where a crash is injected in tests (design §11). */
export enum ReconciliationCheckpoint {
  /** Internal: the snapshot's checks are done; nothing is written yet. */
  AFTER_SNAPSHOT = 'AFTER_SNAPSHOT',
  /** Inside a writing transaction, just before it commits (findings, a settlement, a break). */
  BEFORE_COMMIT = 'BEFORE_COMMIT',
  /** External: a settlement batch is committed; its flows are not yet SETTLED. */
  AFTER_SETTLEMENT_COMMIT = 'AFTER_SETTLEMENT_COMMIT',
  /** External: every step ran; the run is not yet marked finished. */
  BEFORE_FINISH = 'BEFORE_FINISH',
}

export interface ReconciliationCheckpointContext {
  readonly runId: string;
  readonly kind: string;
}

/**
 * The crash-injection seam for reconciliation runs, like `FlowCheckpoints`: a no-op in
 * production; tests replace it to throw at a chosen boundary, then resume the run.
 */
@Injectable()
export class ReconciliationCheckpoints {
  async reached(_point: ReconciliationCheckpoint, _context: ReconciliationCheckpointContext): Promise<void> {
    // Production: nothing to do.
  }
}
