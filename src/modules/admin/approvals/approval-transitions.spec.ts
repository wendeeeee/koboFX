import { APPROVAL_TRANSITIONS, BREAK_GLASS_TRANSITIONS, TERMINAL_APPROVAL_STATUSES, assertApprovalTransition, canTransitionApproval } from './approval-transitions';
import { APPROVAL_STATUS_VALUES, ApprovalStatus } from './approval.types';

describe('approval transitions (the table `approval_transition_allowed` mirrors)', () => {
  it('four-eyes: EXECUTED and EXECUTION_FAILED are reachable only from APPROVED', () => {
    for (const from of APPROVAL_STATUS_VALUES) {
      for (const to of [ApprovalStatus.EXECUTED, ApprovalStatus.EXECUTION_FAILED]) {
        expect({ from, to, allowed: canTransitionApproval(from, to, false) }).toEqual({ from, to, allowed: from === ApprovalStatus.APPROVED });
      }
    }
  });

  it('one decision: PENDING is the only state a decision leaves; APPROVED only from PENDING', () => {
    for (const from of APPROVAL_STATUS_VALUES) {
      for (const to of [ApprovalStatus.APPROVED, ApprovalStatus.REJECTED, ApprovalStatus.CANCELLED, ApprovalStatus.EXPIRED]) {
        expect(canTransitionApproval(from, to, false)).toBe(from === ApprovalStatus.PENDING);
      }
    }
  });

  it('break-glass: PENDING → EXECUTED | EXECUTION_FAILED only — never approved, rejected, cancelled or expired', () => {
    expect(BREAK_GLASS_TRANSITIONS[ApprovalStatus.PENDING]).toEqual([ApprovalStatus.EXECUTED, ApprovalStatus.EXECUTION_FAILED]);
    for (const from of APPROVAL_STATUS_VALUES) {
      if (from !== ApprovalStatus.PENDING) expect(BREAK_GLASS_TRANSITIONS[from]).toEqual([]);
    }
  });

  it('nothing leaves a terminal state, on either path; no state moves to itself', () => {
    for (const terminal of TERMINAL_APPROVAL_STATUSES) {
      expect(APPROVAL_TRANSITIONS[terminal]).toEqual([]);
      expect(BREAK_GLASS_TRANSITIONS[terminal]).toEqual([]);
    }
    for (const status of APPROVAL_STATUS_VALUES) {
      expect(canTransitionApproval(status, status, false)).toBe(false);
      expect(canTransitionApproval(status, status, true)).toBe(false);
    }
  });

  it('assertApprovalTransition fails loudly on an illegal move', () => {
    expect(() => assertApprovalTransition(ApprovalStatus.PENDING, ApprovalStatus.EXECUTED, false)).toThrow(/cannot move from PENDING to EXECUTED/);
    expect(() => assertApprovalTransition(ApprovalStatus.PENDING, ApprovalStatus.EXECUTED, true)).not.toThrow();
  });
});
