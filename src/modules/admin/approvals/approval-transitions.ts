import { InvariantViolationError } from '../../../common/errors';
import { ApprovalStatus } from './approval.types';

/**
 * The approval state machine (Phase 10 plan §G) — the single source `approval_transition_allowed` is tested
 * against, pair for pair.
 *
 * Four-eyes: PENDING → APPROVED (a different eligible person) → EXECUTED | EXECUTION_FAILED, or PENDING →
 * REJECTED | CANCELLED | EXPIRED. EXECUTED is reachable only THROUGH APPROVED.
 * Break-glass: PENDING → EXECUTED | EXECUTION_FAILED, the requester alone, flagged (and nothing else).
 * Nothing leaves a terminal state.
 */
export const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> = {
  [ApprovalStatus.PENDING]: [ApprovalStatus.APPROVED, ApprovalStatus.REJECTED, ApprovalStatus.CANCELLED, ApprovalStatus.EXPIRED],
  [ApprovalStatus.APPROVED]: [ApprovalStatus.EXECUTED, ApprovalStatus.EXECUTION_FAILED],
  [ApprovalStatus.EXECUTED]: [],
  [ApprovalStatus.EXECUTION_FAILED]: [],
  [ApprovalStatus.REJECTED]: [],
  [ApprovalStatus.CANCELLED]: [],
  [ApprovalStatus.EXPIRED]: [],
};

export const BREAK_GLASS_TRANSITIONS: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> = {
  [ApprovalStatus.PENDING]: [ApprovalStatus.EXECUTED, ApprovalStatus.EXECUTION_FAILED],
  [ApprovalStatus.APPROVED]: [],
  [ApprovalStatus.EXECUTED]: [],
  [ApprovalStatus.EXECUTION_FAILED]: [],
  [ApprovalStatus.REJECTED]: [],
  [ApprovalStatus.CANCELLED]: [],
  [ApprovalStatus.EXPIRED]: [],
};

export const TERMINAL_APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  ApprovalStatus.EXECUTED,
  ApprovalStatus.EXECUTION_FAILED,
  ApprovalStatus.REJECTED,
  ApprovalStatus.CANCELLED,
  ApprovalStatus.EXPIRED,
];

export function canTransitionApproval(from: ApprovalStatus, to: ApprovalStatus, isBreakGlass: boolean): boolean {
  return (isBreakGlass ? BREAK_GLASS_TRANSITIONS : APPROVAL_TRANSITIONS)[from].includes(to);
}

export function assertApprovalTransition(from: ApprovalStatus, to: ApprovalStatus, isBreakGlass: boolean): void {
  if (!canTransitionApproval(from, to, isBreakGlass)) {
    throw new InvariantViolationError(`An approval cannot move from ${from} to ${to}.`, { from, to, isBreakGlass });
  }
}
