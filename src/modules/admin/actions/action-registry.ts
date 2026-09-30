import { UserRole } from '../../users/user.types';
import { ApprovalActionType } from '../approvals/approval.types';
import { ActionPayloads, RateOverrideMode } from './action-payloads';

/** What an executor is handed: the approval and who executes it (the approver, or the break-glass actor). */
export interface ExecutionContext {
  readonly approvalId: string;
  readonly requestedBy: string;
  readonly executedBy: string;
  readonly isBreakGlass: boolean;
  /** The approval's own `reason`: the *why* every posting and resolution carries. */
  readonly reason: string;
}

/**
 * One sensitive action. Both methods run inside the caller's transaction and never call a third party.
 *
 * - `validateRequest`: what must hold for the request to make sense now (the break exists and is live, the
 *   user exists…). Refusing early saves an approver's time; it proves nothing about later.
 * - `execute`: RE-VALIDATES everything against the world as it is now, under the locks it takes (the break
 *   may have been resolved, the period closed, the balance changed since the request), then acts. Refusals are
 *   `ActionPreconditionFailedError` (or another permanent `DomainError`): the approval records
 *   EXECUTION_FAILED with that code. Returns the `result_reference` (a transaction, snapshot, lock, user id…).
 */
export interface ActionExecutor<T extends ApprovalActionType = ApprovalActionType> {
  readonly actionType: T;
  validateRequest(payload: ActionPayloads[T], requestedBy: string): Promise<void>;
  execute(payload: ActionPayloads[T], context: ExecutionContext): Promise<string>;
}

export const ACTION_EXECUTORS = Symbol('ACTION_EXECUTORS');

export interface ActionPolicy {
  /** Who may request it. */
  readonly requesterRole: UserRole;
  /** Who may approve or reject it — never the requester. Mirrors SQL `approval_decider_role`. */
  readonly deciderRole: UserRole;
  /** Break-glass (a single actor, flagged, paged, reviewed within 24h) — for these payloads only. */
  readonly breakGlassAllowed: (payload: unknown) => boolean;
}

const never = (): boolean => false;

/**
 * The control matrix (Phase 10 plan §D). An ADMIN requests everything; a SECURITY officer approves role
 * changes (those who use privilege do not grant it), another ADMIN approves the rest. Break-glass exists for
 * two emergencies only: suspending an account (a takeover in progress) and a manual rate when every provider
 * is down (§16) — never money, roles, spreads or periods.
 */
export const ACTION_POLICIES: Readonly<Record<ApprovalActionType, ActionPolicy>> = {
  [ApprovalActionType.CORRECTION]: { requesterRole: UserRole.ADMIN, deciderRole: UserRole.ADMIN, breakGlassAllowed: never },
  [ApprovalActionType.WRITE_OFF]: { requesterRole: UserRole.ADMIN, deciderRole: UserRole.ADMIN, breakGlassAllowed: never },
  [ApprovalActionType.RATE_OVERRIDE]: {
    requesterRole: UserRole.ADMIN,
    deciderRole: UserRole.ADMIN,
    breakGlassAllowed: (payload) => (payload as { mode?: unknown }).mode === RateOverrideMode.MANUAL_RATE,
  },
  [ApprovalActionType.SPREAD_CHANGE]: { requesterRole: UserRole.ADMIN, deciderRole: UserRole.ADMIN, breakGlassAllowed: never },
  [ApprovalActionType.SUSPEND_USER]: { requesterRole: UserRole.ADMIN, deciderRole: UserRole.ADMIN, breakGlassAllowed: () => true },
  [ApprovalActionType.REINSTATE_USER]: { requesterRole: UserRole.ADMIN, deciderRole: UserRole.ADMIN, breakGlassAllowed: never },
  [ApprovalActionType.CLOSE_PERIOD]: { requesterRole: UserRole.ADMIN, deciderRole: UserRole.ADMIN, breakGlassAllowed: never },
  [ApprovalActionType.ROLE_CHANGE]: { requesterRole: UserRole.ADMIN, deciderRole: UserRole.SECURITY, breakGlassAllowed: never },
  [ApprovalActionType.RESOLVE_BREAK]: { requesterRole: UserRole.ADMIN, deciderRole: UserRole.ADMIN, breakGlassAllowed: never },
};
