import { InvariantViolationError } from '../../common/errors';

export enum BreakStatus {
  OPEN = 'OPEN',
  ESCALATED = 'ESCALATED',
  RESOLVED = 'RESOLVED',
}

export enum ResolutionKind {
  FLOW_ADVANCED = 'FLOW_ADVANCED',
  REVERSAL_POSTED = 'REVERSAL_POSTED',
  WEBHOOK_REPROCESSED = 'WEBHOOK_REPROCESSED',
  SETTLED_LATE = 'SETTLED_LATE',
  REPORT_INGESTED = 'REPORT_INGESTED',
  CORRECTION_POSTED = 'CORRECTION_POSTED',
  OPERATOR_RESOLVED = 'OPERATOR_RESOLVED',
  /** An approved PAYSTACK_WITHDRAWAL_RECOVERY applied the evidenced outcome (W4, WITHDRAWAL_PLAN.md §I.3). */
  RECOVERY_APPLIED = 'RECOVERY_APPLIED',
}


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
