import { DomainError, ErrorCode, ErrorDetails } from '../../common/errors';

export class ApprovalNotFoundError extends DomainError {
  readonly code = ErrorCode.APPROVAL_NOT_FOUND;
  readonly httpStatus = 404;

  constructor(approvalId: string) {
    super('Approval not found.', { approvalId });
  }
}

export class UserNotFoundError extends DomainError {
  readonly code = ErrorCode.USER_NOT_FOUND;
  readonly httpStatus = 404;

  constructor(userId: string) {
    super('User not found.', { userId });
  }
}

export class ReconciliationRunNotFoundError extends DomainError {
  readonly code = ErrorCode.RECONCILIATION_RUN_NOT_FOUND;
  readonly httpStatus = 404;

  constructor(runId: string) {
    super('Reconciliation run not found.', { runId });
  }
}

/** Four-eyes (design §9.2): the approver (or rejecter) is never the requester. The database refuses it too. */
export class SelfApprovalForbiddenError extends DomainError {
  readonly code = ErrorCode.SELF_APPROVAL_FORBIDDEN;
  readonly httpStatus = 403;

  constructor(approvalId: string) {
    super('You cannot decide your own request: a different person must approve it.', { approvalId });
  }
}

/** One decision per approval: someone (or something) already decided it. */
export class ApprovalAlreadyDecidedError extends DomainError {
  readonly code = ErrorCode.APPROVAL_ALREADY_DECIDED;
  readonly httpStatus = 409;

  constructor(approvalId: string, status: string) {
    super('This approval is no longer pending.', { approvalId, status });
  }
}

/** Past its `expires_at`: refused; the worker's monitor records it EXPIRED. */
export class ApprovalExpiredError extends DomainError {
  readonly code = ErrorCode.APPROVAL_EXPIRED;
  readonly httpStatus = 409;

  constructor(approvalId: string, expiresAt: Date) {
    super('This approval request has expired; request it again.', { approvalId, expiresAt: expiresAt.toISOString() });
  }
}

/** The requester no longer holds the role (or is suspended): their request can no longer be approved. */
export class ApprovalRequesterIneligibleError extends DomainError {
  readonly code = ErrorCode.APPROVAL_REQUESTER_INELIGIBLE;
  readonly httpStatus = 409;

  constructor(approvalId: string) {
    super('The requester is no longer an active administrator; this request cannot be approved.', { approvalId });
  }
}

/** Break-glass exists for a defined subset of actions only (design §9.2). */
export class BreakGlassNotAllowedError extends DomainError {
  readonly code = ErrorCode.BREAK_GLASS_NOT_ALLOWED;
  readonly httpStatus = 403;

  constructor(details: ErrorDetails) {
    super('Break-glass is not allowed for this action: it needs a second approver.', details);
  }
}

export class BreakGlassAlreadyReviewedError extends DomainError {
  readonly code = ErrorCode.BREAK_GLASS_ALREADY_REVIEWED;
  readonly httpStatus = 409;

  constructor(approvalId: string) {
    super('This break-glass use is not awaiting review.', { approvalId });
  }
}

/**
 * What an action needs from the world does not hold — at request time, or again at execution (the world may
 * have moved since). `reason` is a stable code; an approval that fails at execution records it as its
 * `execution_failure_code`.
 */
export class ActionPreconditionFailedError extends DomainError {
  readonly code = ErrorCode.ACTION_PRECONDITION_FAILED;
  readonly httpStatus = 409;

  constructor(
    readonly reason: string,
    message: string,
    details: ErrorDetails = {},
  ) {
    super(message, { reason, ...details });
  }
}
