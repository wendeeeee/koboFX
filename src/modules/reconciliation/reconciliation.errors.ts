import { DomainError, ErrorCode } from '../../common/errors';

/** Another worker took the run over (our lease lapsed); our result is discarded. */
export class ReconciliationRunLeaseLostError extends DomainError {
  readonly code = ErrorCode.RECONCILIATION_RUN_LEASE_LOST;
  readonly httpStatus = 409;
  override readonly permanent = false;

  constructor(runId: string) {
    super('The reconciliation run is no longer leased by this worker.', { runId });
  }
}

/** A break was asked to move along a transition its table does not have, or it does not exist. */
export class ReconciliationBreakNotFoundError extends DomainError {
  readonly code = ErrorCode.RECONCILIATION_BREAK_NOT_FOUND;
  readonly httpStatus = 404;

  constructor(breakId: string) {
    super('Reconciliation break not found.', { breakId });
  }
}
