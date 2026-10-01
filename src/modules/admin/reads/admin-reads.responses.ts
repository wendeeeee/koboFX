import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { ApiAmount, ApiCurrency, ApiFreeObject, ApiInstant, ApiMinorUnit, ApiUuid } from '../../../openapi/properties';
import { RateTier } from '../../fx/freshness';
import { BreakStatus, ResolutionKind } from '../../reconciliation/break-transitions';
import { BreakType } from '../../reconciliation/break-types';
import { ReconciliationRunStatus } from '../../reconciliation/reconciliation-run.repository';
import { ReconciliationRunKind } from '../../reconciliation/reconciliation-schedule';
import { UserRole, UserStatus } from '../../users/user.types';
import { ApprovalDocument, AuditTrailEntryDocument } from '../approvals/approval.responses';
import type { PositionView, PositionsView, TrialBalanceView } from '../positions/positions.service';
import type {
  AdminUserView,
  BreakDetailView,
  BreakView,
  FindingView,
  RecertificationEntry,
  RecertificationReport,
  RunDetailView,
  RunView,
} from './admin-reads.service';

/** OpenAPI documentation of the admin read models (Phase 11). Never instantiated. Ids and codes only. */
const BREAK_ID = '1f2e3d4c-5b6a-4798-8a7b-6c5d4e3f2a1b';
const RUN_ID = '0a1b2c3d-4e5f-4a6b-9c8d-7e6f5a4b3c2d';
const USER_ID = '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d';

@ApiSchema({ name: 'PositionMarking' })
export class PositionMarkingDocument {
  @ApiUuid('The snapshot the position is marked by.', '5e4d3c2b-1a09-4f8e-a7d6-c5b4a3928170')
  snapshotId!: string;

  @ApiProperty({ example: 'exchange-rate-api' })
  provider!: string;

  @ApiInstant('The rate\'s publication time.', '2026-09-29T10:00:00.000Z')
  asOf!: string;

  @ApiProperty({ type: 'integer', minimum: 0, example: 95 })
  rateAgeSeconds!: number;

  @ApiProperty({ enum: RateTier, enumName: 'RateTier', example: RateTier.EXECUTABLE })
  tier!: RateTier;

  @ApiProperty({ example: false, description: 'Stale or halted rates still mark the position — flagged here.' })
  stale!: boolean;
}

@ApiSchema({ name: 'CurrencyPosition' })
export class PositionDocument implements PositionView {
  @ApiCurrency()
  currency!: string;

  @ApiMinorUnit()
  minorUnit!: number;

  @ApiAmount('`FX_POSITION` summed over buckets; long is positive.', '-98499')
  position!: string;

  @ApiAmount('Marked to USD at the reference rate, in USD minor units (rounded once, half-even); null without a rate.', '-98499', { nullable: true })
  markedUsd!: string | null;
}

@ApiSchema({ name: 'TrialBalance' })
export class TrialBalanceDocument implements TrialBalanceView {
  @ApiCurrency()
  currency!: string;

  @ApiAmount('Σ debits.', '306000000')
  debits!: string;

  @ApiAmount('Σ credits.', '306000000')
  credits!: string;

  @ApiProperty({ example: true })
  balanced!: boolean;

  @ApiAmount('Assets.', '153000000')
  assets!: string;

  @ApiAmount('Liabilities (user balances).', '0')
  liabilities!: string;

  @ApiAmount('Equity.', '153000000')
  equity!: string;

  @ApiAmount('Revenue.', '0')
  revenue!: string;

  @ApiAmount('Expenses.', '0')
  expenses!: string;

  @ApiProperty({ example: true, description: '`assets = liabilities + equity + revenue − expenses`, per currency.' })
  equationHolds!: boolean;
}

@ApiSchema({ name: 'Positions' })
export class PositionsDocument implements PositionsView {
  @ApiProperty({ type: PositionMarkingDocument, nullable: true, description: 'Null when no snapshot exists.' })
  markedBy!: PositionMarkingDocument | null;

  @ApiProperty({ type: [PositionDocument] })
  positions!: PositionDocument[];

  @ApiAmount('Σ marked positions, USD minor units; null if any is unmarked.', '0', { nullable: true })
  totalMarkedUsd!: string | null;

  @ApiProperty({ type: [TrialBalanceDocument], description: 'Per currency — never summed across currencies.' })
  trialBalance!: TrialBalanceDocument[];
}

@ApiSchema({ name: 'BreakEvidence' })
export class BreakEvidenceDocument {
  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: null })
  flowId!: string | null;

  @ApiProperty({ type: 'string', nullable: true, example: 'pay_8f7e6d5c4b3a' })
  providerPaymentId!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: null })
  settlementBatchId!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: null })
  settlementBatchLineId!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: null })
  webhookEventId!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: null })
  ledgerAccountId!: string | null;

  @ApiUuid('The run that first detected it.', RUN_ID)
  detectedByRunId!: string;

  @ApiUuid('The run that last detected it.', RUN_ID)
  lastDetectedRunId!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: null, description: 'The earlier break on the same subject, if this one re-opened it.' })
  previousBreakId!: string | null;

  @ApiFreeObject('Type-specific evidence (amounts as minor-unit strings).', { example: { expectedAmount: '150000', settledAmount: '149000' } })
  details!: Record<string, unknown>;
}

@ApiSchema({ name: 'ReconciliationBreak' })
export class BreakDocument implements BreakView {
  @ApiUuid('The break id.', BREAK_ID)
  breakId!: string;

  @ApiProperty({ enum: BreakType, enumName: 'BreakType', example: BreakType.AMOUNT_MISMATCH })
  type!: string;

  @ApiProperty({ enum: ['MONEY', 'SECURITY', 'INVESTIGATE'], example: 'MONEY' })
  severity!: 'MONEY' | 'SECURITY' | 'INVESTIGATE';

  @ApiProperty({ enum: BreakStatus, enumName: 'BreakStatus', example: BreakStatus.ESCALATED })
  status!: string;

  @ApiProperty({ example: 'payment:pay_8f7e6d5c4b3a', description: 'What the break is about; one live break per (type, subject).' })
  subjectKey!: string;

  @ApiProperty({ type: 'string', nullable: true, pattern: '^[A-Z]{3}$', example: 'NGN' })
  currency!: string | null;

  @ApiAmount('The amount at stake (counts toward drift for MONEY breaks).', '1000')
  amount!: string;

  @ApiInstant('First detected.')
  firstDetectedAt!: string;

  @ApiInstant('Last detected.')
  lastDetectedAt!: string;

  @ApiInstant('When escalated.', null, { nullable: true })
  escalatedAt!: string | null;

  @ApiInstant('When resolved.', null, { nullable: true })
  resolvedAt!: string | null;

  @ApiProperty({ enum: ResolutionKind, enumName: 'BreakResolutionKind', nullable: true, example: null })
  resolutionKind!: string | null;

  @ApiProperty({ type: 'string', nullable: true, example: null, description: 'E.g. `approval:{id}` for a correction.' })
  resolutionReference!: string | null;

  @ApiProperty({ type: 'string', nullable: true, example: null, description: '`job:{name}` or `operator:{id}`.' })
  resolvedBy!: string | null;

  @ApiProperty({ type: 'string', nullable: true, example: null })
  note!: string | null;

  @ApiProperty({ type: BreakEvidenceDocument })
  evidence!: BreakEvidenceDocument;
}

@ApiSchema({ name: 'ReconciliationFinding' })
export class FindingDocument implements FindingView {
  @ApiUuid('The run.', RUN_ID)
  runId!: string;

  @ApiProperty({ example: 'TRIAL_BALANCE' })
  kind!: string;

  @ApiProperty({ type: 'string', nullable: true, example: 'NGN' })
  currency!: string | null;

  @ApiProperty({ example: 'NGN' })
  subject!: string;

  @ApiFreeObject('What was measured (amounts as minor-unit strings).', { example: { debits: '306000000', credits: '306000000' } })
  measured!: Record<string, unknown>;

  @ApiAmount('The drift found (zero when clean).', '0')
  drift!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: null })
  breakId!: string | null;

  @ApiInstant('When recorded.')
  recordedAt!: string;
}

@ApiSchema({ name: 'ReconciliationBreakDetail' })
export class BreakDetailDocument extends BreakDocument implements BreakDetailView {
  @ApiProperty({ type: [FindingDocument] })
  findings!: FindingDocument[];

  @ApiProperty({ type: [ApprovalDocument], description: 'Approvals naming this break.' })
  approvals!: ApprovalDocument[];

  @ApiProperty({ type: [AuditTrailEntryDocument] })
  trail!: AuditTrailEntryDocument[];
}

@ApiSchema({ name: 'ReconciliationBreakPage' })
export class BreakPageDocument {
  @ApiProperty({ type: [BreakDocument] })
  items!: BreakDocument[];

  @ApiProperty({ type: 'string', nullable: true, example: null, description: 'Next page cursor (same filters); null on the last page.' })
  nextCursor!: string | null;
}

@ApiSchema({ name: 'ReconciliationRun' })
export class RunDocument implements RunView {
  @ApiUuid('The run id.', RUN_ID)
  runId!: string;

  @ApiProperty({ enum: ReconciliationRunKind, enumName: 'ReconciliationRunKind', example: ReconciliationRunKind.INTERNAL })
  kind!: string;

  @ApiProperty({ example: '2026-09-29', description: 'The period the run covers (one run per kind and period).' })
  periodKey!: string;

  @ApiProperty({ enum: ReconciliationRunStatus, enumName: 'ReconciliationRunStatus', example: ReconciliationRunStatus.CLEAN })
  status!: string;

  @ApiProperty({ type: 'integer', minimum: 0, example: 1 })
  attempts!: number;

  @ApiInstant('Started.')
  startedAt!: string;

  @ApiInstant('Finished.', '2026-09-29T01:00:07.000Z', { nullable: true })
  finishedAt!: string | null;

  @ApiInstant('The snapshot the internal checks read.', null, { nullable: true })
  snapshotAt!: string | null;

  @ApiFreeObject('Counts and drift per check.', { example: { breaksDetected: 0 } })
  summary!: Record<string, unknown>;

  @ApiProperty({ type: 'string', nullable: true, example: null })
  lastError!: string | null;
}

@ApiSchema({ name: 'ReconciliationRunDetail' })
export class RunDetailDocument extends RunDocument implements RunDetailView {
  @ApiProperty({ type: [FindingDocument] })
  findings!: FindingDocument[];

  @ApiProperty({ type: 'integer', minimum: 0, example: 0 })
  breaksDetected!: number;
}

@ApiSchema({ name: 'ReconciliationRunPage' })
export class RunPageDocument {
  @ApiProperty({ type: [RunDocument] })
  items!: RunDocument[];

  @ApiProperty({ type: 'string', nullable: true, example: null, description: 'Next page cursor (same filters); null on the last page.' })
  nextCursor!: string | null;
}

@ApiSchema({ name: 'AdminUser' })
export class AdminUserDocument implements AdminUserView {
  @ApiUuid('The user id.', USER_ID)
  userId!: string;

  @ApiProperty({ enum: UserStatus, enumName: 'UserStatus', example: UserStatus.ACTIVE })
  status!: string;

  @ApiProperty({ enum: UserRole, enumName: 'UserRole', example: UserRole.USER })
  role!: string;

  @ApiInstant('Created.')
  createdAt!: string;

  @ApiInstant('Verified.', '2026-09-29T10:00:00.000Z', { nullable: true })
  verifiedAt!: string | null;
}

@ApiSchema({ name: 'RoleHolder' })
export class RecertificationEntryDocument implements RecertificationEntry {
  @ApiUuid('The holder.', USER_ID)
  userId!: string;

  @ApiProperty({ enum: ['ADMIN', 'SECURITY'], example: 'ADMIN' })
  role!: string;

  @ApiProperty({ enum: UserStatus, enumName: 'UserStatus', example: UserStatus.ACTIVE })
  status!: string;

  @ApiInstant('Held since.')
  since!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: null, description: 'Who approved the grant (null for the bootstrap).' })
  grantedBy!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: null })
  grantApprovalId!: string | null;

  @ApiProperty({ example: true, description: 'Granted by `npm run admin:bootstrap`.' })
  bootstrap!: boolean;

  @ApiInstant('The last session the holder started (standing privilege nobody uses is drift too).', null, { nullable: true })
  lastSessionStartedAt!: string | null;
}

@ApiSchema({ name: 'RecertificationDiscrepancy' })
export class RecertificationDiscrepancyDocument {
  @ApiUuid('The user.', USER_ID)
  userId!: string;

  @ApiProperty({ example: 'ADMIN' })
  role!: string;

  @ApiProperty({ example: 'ROLE_WITHOUT_ASSIGNMENT' })
  problem!: string;
}

@ApiSchema({ name: 'Recertification' })
export class RecertificationDocument implements RecertificationReport {
  @ApiInstant('When generated.')
  generatedAt!: string;

  @ApiProperty({ type: [RecertificationEntryDocument] })
  holders!: RecertificationEntryDocument[];

  @ApiProperty({ type: [RecertificationDiscrepancyDocument], description: 'Must be empty: privileged roles without a live assignment record, or the reverse.' })
  discrepancies!: RecertificationDiscrepancyDocument[];
}
