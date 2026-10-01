import { ApiExtraModels, ApiProperty, ApiSchema, getSchemaPath } from '@nestjs/swagger';
import { ApiAmount, ApiCurrency, ApiDisplayRate, ApiFreeObject, ApiInstant, ApiMinorUnit, ApiUuid } from '../../openapi/properties';
import { EXAMPLE_SNAPSHOT_ID } from '../fx/fx.responses';
import { HISTORY_TYPES, HistoryInitiator, HistoryStatus, PUBLIC_REASON_CODES } from './history-status';
import type {
  AdminLegView,
  AdminTransactionView,
  AmountView,
  DetailLegView,
  DetailRateView,
  LegView,
  LinkView,
  ListRateView,
  TransactionDetailView,
  TransactionListItemView,
} from './transaction.view';
import type { TransactionPage } from './transaction-history.service';

/**
 * OpenAPI documentation of history (Phase 11). Never instantiated: `implements` keeps each class in step with the
 * view the code returns. Every figure on the wire is a stored one (amounts as minor-unit strings).
 */
const FUNDING_REFERENCE = 'funding:3c9a1f2e-7b4d-4e6a-9f80-1a2b3c4d5e6f';

@ApiSchema({ name: 'TransactionLeg' })
export class LegDocument implements LegView {
  @ApiCurrency()
  currency!: string;

  @ApiMinorUnit()
  minorUnit!: number;

  @ApiProperty({
    enum: ['DEBIT', 'CREDIT'],
    example: 'CREDIT',
    description: 'The ledger\'s direction on YOUR account (a liability, so it reads like a bank statement): DEBIT = out, CREDIT = in.',
  })
  direction!: 'DEBIT' | 'CREDIT';

  @ApiAmount('Moved on this leg.', '150000')
  amount!: string;
}

@ApiSchema({ name: 'TransactionDetailLeg' })
export class DetailLegDocument extends LegDocument implements DetailLegView {
  @ApiAmount('Your account\'s balance after this booking (booking order, not value order).', '250000')
  balanceAfter!: string;
}

@ApiSchema({ name: 'RequestedAmount' })
export class AmountDocument implements AmountView {
  @ApiCurrency()
  currency!: string;

  @ApiMinorUnit()
  minorUnit!: number;

  @ApiAmount('What the funding asked for.', '150000')
  amount!: string;
}

@ApiSchema({ name: 'TransactionLink' })
export class TransactionLinkDocument {
  @ApiProperty({ example: 'chargeback:3c9a1f2e-7b4d-4e6a-9f80-1a2b3c4d5e6f' })
  reference!: string;

  @ApiProperty({ example: 'REVERSAL' })
  type!: string;
}

@ApiSchema({ name: 'InternalTransactionLink' })
export class InternalTransactionLinkDocument {
  @ApiProperty({ enum: [true], example: true, description: 'The other end is one of our internal transactions (e.g. a settlement); its content is not shown.' })
  internal!: true;
}

const linkProperty = (description: string): PropertyDecorator =>
  ApiProperty({
    oneOf: [{ $ref: getSchemaPath(TransactionLinkDocument) }, { $ref: getSchemaPath(InternalTransactionLinkDocument) }],
    nullable: true,
    example: null,
    description,
  });

@ApiSchema({ name: 'TransactionListRate' })
export class ListRateDocument implements ListRateView {
  @ApiDisplayRate('The effective rate, derived from the two amounts at posting.', '0.000643784313725')
  rateDisplay!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: null, description: 'The quote a trade executed; null for a market conversion.' })
  quoteId!: string | null;
}

@ApiSchema({ name: 'TransactionDetailRate' })
export class DetailRateDocument extends ListRateDocument implements DetailRateView {
  @ApiDisplayRate('The reference mid priced off (target per source).', '0.000653594771242')
  referenceRate!: string;

  @ApiProperty({ type: 'integer', minimum: 0, example: 150 })
  spreadBasisPoints!: number;

  @ApiProperty({ example: 'exchange-rate-api' })
  provider!: string;

  @ApiInstant('The provider\'s publication time of the rate.', '2026-09-29T10:00:00.000Z')
  asOf!: string;

  @ApiInstant('When we fetched it.', '2026-09-29T10:00:41.000Z')
  fetchedAt!: string;

  @ApiUuid('The rate snapshot priced off.', EXAMPLE_SNAPSHOT_ID)
  snapshotId!: string;
}

/** The fields every history shape shares. */
@ApiExtraModels(TransactionLinkDocument, InternalTransactionLinkDocument)
abstract class TransactionBaseDocument {
  @ApiProperty({
    example: FUNDING_REFERENCE,
    description: 'Stable and unique: `{kind}:{uuid}`. A funding is listed as `funding:{fundingId}` from the moment it is requested.',
  })
  reference!: string;

  @ApiProperty({ enum: HISTORY_TYPES, enumName: 'TransactionType', example: 'FUNDING' })
  type!: string;

  @ApiProperty({
    enum: ['PENDING', 'COMPLETED', 'FAILED', 'REVERSED'],
    enumName: 'TransactionStatus',
    example: 'COMPLETED',
    description: 'One vocabulary for every item. A reversed original shows REVERSED; the reversal itself is COMPLETED.',
  })
  status!: HistoryStatus;

  @ApiProperty({
    enum: PUBLIC_REASON_CODES,
    enumName: 'ReasonCode',
    nullable: true,
    example: 'CARD_DEPOSIT',
    description: 'Public and stable: clients may branch on it. Null for a funding not booked yet.',
  })
  reasonCode!: string | null;

  @ApiProperty({ type: AmountDocument, nullable: true, example: null, description: 'What a funding that never posted asked for; null once money moved (see `legs`).' })
  requested!: AmountDocument | null;

  @ApiProperty({ type: 'string', nullable: true, example: null, description: 'Why a funding FAILED (the PSP\'s status and decline code).' })
  failureCode!: string | null;

  @ApiInstant('When it happened (the sort key by default).')
  valueTime!: string;

  @ApiInstant('When it was recorded.')
  bookingTime!: string;

  @linkProperty('The transaction this one corrects or reverses.')
  corrects!: LinkView | null;

  @linkProperty('The transaction that corrected or reversed this one.')
  correctedBy!: LinkView | null;
}

@ApiSchema({ name: 'TransactionListItem' })
export class TransactionListItemDocument extends TransactionBaseDocument implements TransactionListItemView {
  @ApiProperty({ type: [LegDocument], description: 'Your own legs only (internal accounts are never shown). Empty for a funding that never posted.' })
  legs!: LegDocument[];

  @ApiProperty({ type: ListRateDocument, nullable: true, example: null, description: 'Conversions only.' })
  rate!: ListRateDocument | null;
}

abstract class TransactionDetailBaseDocument extends TransactionBaseDocument {
  @ApiProperty({ type: DetailRateDocument, nullable: true, example: null, description: 'Conversions only: the stored provenance.' })
  rate!: DetailRateDocument | null;

  @ApiInstant('When the PSP settled a funding to us; null otherwise.', null, { nullable: true })
  settlementTime!: string | null;

  @ApiProperty({ enum: ['USER', 'SYSTEM', 'OPERATOR'], example: 'USER', description: 'Who started it (no identities).' })
  initiatedBy!: HistoryInitiator;
}

@ApiSchema({ name: 'TransactionDetail' })
export class TransactionDetailDocument extends TransactionDetailBaseDocument implements TransactionDetailView {
  @ApiProperty({ type: [DetailLegDocument], description: 'Your own legs, each with the balance after it.' })
  legs!: DetailLegDocument[];
}

@ApiSchema({ name: 'TransactionPage' })
export class TransactionPageDocument implements TransactionPage {
  @ApiProperty({ type: [TransactionListItemDocument] })
  items!: TransactionListItemDocument[];

  @ApiProperty({
    type: 'string',
    nullable: true,
    example: null,
    description: 'Pass as `cursor` for the next page, with the SAME sort and filters (`limit` may change). Null on the last page.',
  })
  nextCursor!: string | null;
}

@ApiSchema({ name: 'AdminTransactionLeg' })
export class AdminLegDocument extends DetailLegDocument implements AdminLegView {
  @ApiProperty({ example: 'USER:1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d:NGN', description: 'The ledger account code (internal accounts included).' })
  accountCode!: string;

  @ApiProperty({ type: 'integer', minimum: 0, example: 0, description: 'The account bucket (user accounts are bucket 0).' })
  bucket!: number;

  @ApiProperty({ enum: ['USER', 'INTERNAL'], example: 'USER' })
  owner!: 'USER' | 'INTERNAL';
}

@ApiSchema({ name: 'AdminTransaction' })
export class AdminTransactionDocument extends TransactionDetailBaseDocument implements AdminTransactionView {
  @ApiProperty({ type: [AdminLegDocument], description: 'EVERY leg of the transaction, internal accounts included.' })
  legs!: AdminLegDocument[];

  @ApiProperty({ example: 'user:8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d', description: 'The initiator with its identity: `user:{id}`, `job:{name}` or `operator:{id}`.' })
  initiatedByIdentity!: string;

  @ApiFreeObject('Internal metadata (flow id, approval id, …).', { example: { flowId: '3c9a1f2e-7b4d-4e6a-9f80-1a2b3c4d5e6f' } })
  metadata!: Record<string, unknown>;

  @ApiProperty({ type: 'string', nullable: true, example: 'pay_8f7e6d5c4b3a', description: 'The provider\'s id (payment, dispute, batch).' })
  externalReference!: string | null;

  @ApiProperty({ type: 'string', nullable: true, example: null, description: 'For a correction of an internal transaction: what it corrects (`line:{id}`).' })
  correctionSubject!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: null, description: 'The approval that posted it (corrections, write-offs).' })
  approvalId!: string | null;
}

@ApiSchema({ name: 'AdminTransactionPage' })
export class AdminTransactionPageDocument {
  @ApiProperty({ type: [AdminTransactionDocument] })
  items!: AdminTransactionDocument[];

  @ApiProperty({ type: 'string', nullable: true, example: null, description: 'Next page cursor (same sort and filters); null on the last page.' })
  nextCursor!: string | null;
}
