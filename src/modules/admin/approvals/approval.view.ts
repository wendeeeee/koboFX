import { Approval } from './approval.types';

/** An approval on the wire (admin only): ids, codes, ISO times — the payload as stored (canonical). */
export interface ApprovalView {
  readonly approvalId: string;
  readonly actionType: string;
  readonly status: string;
  readonly payload: Record<string, unknown>;
  readonly payloadHash: string;
  readonly reason: string;
  readonly breakGlass: boolean;
  readonly breakId: string | null;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly rejectedBy: string | null;
  readonly rejectedAt: string | null;
  readonly rejectionReason: string | null;
  readonly cancelledAt: string | null;
  readonly expiredAt: string | null;
  readonly executedBy: string | null;
  readonly executedAt: string | null;
  readonly executionFailureCode: string | null;
  readonly resultReference: string | null;
  readonly review: { readonly reviewedBy: string; readonly reviewedAt: string; readonly note: string } | null;
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function toApprovalView(approval: Approval): ApprovalView {
  return {
    approvalId: approval.id,
    actionType: approval.actionType,
    status: approval.status,
    payload: approval.payload,
    payloadHash: approval.payloadHash,
    reason: approval.reason,
    breakGlass: approval.isBreakGlass,
    breakId: approval.breakId,
    requestedBy: approval.requestedBy,
    requestedAt: approval.requestedAt.toISOString(),
    expiresAt: approval.expiresAt.toISOString(),
    approvedBy: approval.approvedBy,
    approvedAt: iso(approval.approvedAt),
    rejectedBy: approval.rejectedBy,
    rejectedAt: iso(approval.rejectedAt),
    rejectionReason: approval.rejectionReason,
    cancelledAt: iso(approval.cancelledAt),
    expiredAt: iso(approval.expiredAt),
    executedBy: approval.executedBy,
    executedAt: iso(approval.executedAt),
    executionFailureCode: approval.executionFailureCode,
    resultReference: approval.resultReference,
    review:
      approval.breakGlassReviewedBy && approval.breakGlassReviewedAt && approval.breakGlassReviewNote !== null
        ? { reviewedBy: approval.breakGlassReviewedBy, reviewedAt: approval.breakGlassReviewedAt.toISOString(), note: approval.breakGlassReviewNote }
        : null,
  };
}
