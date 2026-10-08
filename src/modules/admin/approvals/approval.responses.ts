import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { ApiFreeObject, ApiInstant, ApiUuid } from '../../../openapi/properties';
import { payloadSchemaName } from '../actions/action-payload.schemas';
import type { AuditTrailEntry } from '../reads/audit-trail.reader';
import type { ApprovalDetailView } from './approvals.controller';
import { ApprovalActionType, ApprovalStatus } from './approval.types';
import type { ApprovalView } from './approval.view';

/** OpenAPI documentation of the approval bodies (Phase 11). Never instantiated. Ids and codes only — never an email. */
const ADMIN_ID = '4b3a2918-0f7e-4d6c-9b5a-493827160504';
const OTHER_ADMIN_ID = '6d5c4b3a-2918-4f7e-8d6c-5b4a39281706';

@ApiSchema({ name: 'BreakGlassReview' })
export class BreakGlassReviewDocument {
  @ApiUuid('The SECURITY officer who reviewed it (never the actor).', OTHER_ADMIN_ID)
  reviewedBy!: string;

  @ApiInstant('When.', '2026-09-29T14:00:00.000Z')
  reviewedAt!: string;

  @ApiProperty({ example: 'Justified: provider outage confirmed.' })
  note!: string;
}

const storedPayloadSchemas = Object.values(ApprovalActionType).map((actionType) => ({
  $ref: `#/components/schemas/${actionType === ApprovalActionType.CLOSE_PERIOD ? 'StoredClosePeriodPayload' : payloadSchemaName(actionType)}`,
}));

@ApiSchema({ name: 'Approval' })
export class ApprovalDocument implements ApprovalView {
  @ApiUuid('The approval id.', '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a')
  approvalId!: string;

  @ApiProperty({ enum: ApprovalActionType, enumName: 'ApprovalActionType', example: ApprovalActionType.WRITE_OFF })
  actionType!: string;

  @ApiProperty({
    enum: ApprovalStatus,
    enumName: 'ApprovalStatus',
    example: ApprovalStatus.EXECUTED,
    description:
      'PENDING → APPROVED → EXECUTED | EXECUTION_FAILED (approval executes at once, in the approver\'s request), or ' +
      'REJECTED | CANCELLED | EXPIRED. Break-glass: PENDING → EXECUTED | EXECUTION_FAILED in the request itself.',
  })
  status!: string;

  @ApiProperty({
    anyOf: storedPayloadSchemas,
    description: 'The payload of `actionType` as stored (canonical form; CLOSE_PERIOD with its bounds).',
    example: { userId: '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d', currency: 'NGN', amount: '250000', valueTime: '2026-09-29T08:00:00.000Z' },
  })
  payload!: Record<string, unknown>;

  @ApiProperty({ pattern: '^[0-9a-f]{64}$', example: 'c0ffee'.padEnd(64, '0'), description: 'SHA-256 of the canonical payload.' })
  payloadHash!: string;

  @ApiProperty({ example: 'Chargeback overdraft unrecoverable after 90 days.' })
  reason!: string;

  @ApiProperty({ example: false })
  breakGlass!: boolean;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: null, description: 'The break the payload names, if any.' })
  breakId!: string | null;

  @ApiUuid('The requesting ADMIN.', ADMIN_ID)
  requestedBy!: string;

  @ApiInstant('When requested.', '2026-09-29T09:00:00.000Z')
  requestedAt!: string;

  @ApiInstant('Undecided after this, it is refused (`409 APPROVAL_EXPIRED`) and swept to EXPIRED.', '2026-10-02T09:00:00.000Z')
  expiresAt!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: OTHER_ADMIN_ID })
  approvedBy!: string | null;

  @ApiInstant('When approved.', '2026-09-29T09:30:00.000Z', { nullable: true })
  approvedAt!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: null })
  rejectedBy!: string | null;

  @ApiInstant('When rejected.', null, { nullable: true })
  rejectedAt!: string | null;

  @ApiProperty({ type: 'string', nullable: true, example: null })
  rejectionReason!: string | null;

  @ApiInstant('When cancelled by the requester.', null, { nullable: true })
  cancelledAt!: string | null;

  @ApiInstant('When swept to EXPIRED.', null, { nullable: true })
  expiredAt!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: OTHER_ADMIN_ID, description: 'The approver (or the break-glass actor).' })
  executedBy!: string | null;

  @ApiInstant('When executed (or refused at execution).', '2026-09-29T09:30:00.000Z', { nullable: true })
  executedAt!: string | null;

  @ApiProperty({ type: 'string', nullable: true, example: null, description: 'EXECUTION_FAILED: the error code the executor refused with (the world had moved).' })
  executionFailureCode!: string | null;

  @ApiProperty({ type: 'string', nullable: true, example: 'approval:9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a', description: 'What it did (a transaction reference, a user id, a snapshot id…).' })
  resultReference!: string | null;

  @ApiProperty({ type: BreakGlassReviewDocument, nullable: true, example: null, description: 'Break-glass only, once SECURITY reviewed it.' })
  review!: BreakGlassReviewDocument | null;
}

@ApiSchema({ name: 'AuditTrailEntry' })
export class AuditTrailEntryDocument implements AuditTrailEntry {
  @ApiInstant('When.')
  occurredAt!: string;

  @ApiProperty({ example: 'APPROVAL_EXECUTED' })
  action!: string;

  @ApiProperty({ example: 'OPERATOR' })
  actorType!: string;

  @ApiProperty({ type: 'string', nullable: true, example: OTHER_ADMIN_ID })
  actorId!: string | null;

  @ApiProperty({ example: 'APPROVAL' })
  subjectType!: string;

  @ApiProperty({ example: '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a' })
  subjectId!: string;

  @ApiFreeObject('State before (typed fields only; no personal data).', { nullable: true, example: { approvalStatus: 'APPROVED' } })
  before!: Record<string, unknown> | null;

  @ApiFreeObject('State after.', { nullable: true, example: { approvalStatus: 'EXECUTED' } })
  after!: Record<string, unknown> | null;

  @ApiProperty({ example: 'executed: approval:9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a' })
  reason!: string;
}

@ApiSchema({ name: 'ApprovalDetail' })
export class ApprovalDetailDocument extends ApprovalDocument implements ApprovalDetailView {
  @ApiProperty({ type: [AuditTrailEntryDocument], description: 'Request → decision → execution → what it did.' })
  trail!: AuditTrailEntryDocument[];
}

@ApiSchema({ name: 'ApprovalPage' })
export class ApprovalPageDocument {
  @ApiProperty({ type: [ApprovalDocument] })
  items!: ApprovalDocument[];

  @ApiProperty({ type: 'string', nullable: true, example: null, description: 'Next page cursor (same filters); null on the last page.' })
  nextCursor!: string | null;
}
