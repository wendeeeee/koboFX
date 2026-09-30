import { InvariantViolationError } from '../../common/errors';

/** A break's lifecycle (Phase 9 plan §F). */
export enum BreakStatus {
  OPEN = 'OPEN',
  ESCALATED = 'ESCALATED',
  RESOLVED = 'RESOLVED',
}

/** What resolved a break — always a named cause, never "it went away". */
export enum ResolutionKind {
  /** A flow was driven through `FlowRunner` (the webhook that never arrived). */
  FLOW_ADVANCED = 'FLOW_ADVANCED',
  /** A chargeback was reversed through `buildReversalRequest()` (or the deposit was). */
  REVERSAL_POSTED = 'REVERSAL_POSTED',
  /** The stored raw webhook was reprocessed and matched a flow. */
  WEBHOOK_REPROCESSED = 'WEBHOOK_REPROCESSED',
  /** A batch line settled the deposit after its window. */
  SETTLED_LATE = 'SETTLED_LATE',
  /** A report that could not be read was later read and ingested. */
  REPORT_INGESTED = 'REPORT_INGESTED',
  /** Phase 10: an approved CORRECTION posting. */
  CORRECTION_POSTED = 'CORRECTION_POSTED',
  /** Phase 10: an operator's documented decision. */
  OPERATOR_RESOLVED = 'OPERATOR_RESOLVED',
}

/** The pure transition table — the single source `reconciliation_break_transition_allowed` is tested against. */
export const BREAK_TRANSITIONS: Readonly<Record<BreakStatus, readonly BreakStatus[]>> = {
  [BreakStatus.OPEN]: [BreakStatus.ESCALATED, BreakStatus.RESOLVED],
  [BreakStatus.ESCALATED]: [BreakStatus.RESOLVED],
  [BreakStatus.RESOLVED]: [],
};

export const BREAK_STATUSES: readonly BreakStatus[] = Object.values(BreakStatus);

export function canTransitionBreak(from: BreakStatus, to: BreakStatus): boolean {
  return BREAK_TRANSITIONS[from].includes(to);
}

export function assertBreakTransition(from: BreakStatus, to: BreakStatus): void {
  if (!canTransitionBreak(from, to)) {
    throw new InvariantViolationError(`A reconciliation break cannot move from ${from} to ${to}.`, { from, to });
  }
}
