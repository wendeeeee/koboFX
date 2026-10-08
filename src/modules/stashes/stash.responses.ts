import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { ApiCurrency, ApiInstant, ApiMinorUnit, ApiMinorUnits, ApiUuid, MINOR_UNITS_PATTERN_19 } from '../../openapi/properties';
import { STASH_KIND, StashBalanceView, StashReceiptKind, StashReceiptView, StashTransactionsPage, StashView } from './stash.service';

const STASH_ID = '0b6c2f7e-1d3a-4c5b-9e8f-7a6b5c4d3e2f';
const RECEIPT_ID = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
const WITHDRAWAL_ID = '3f2c4c3e-8d2b-4a51-9b6f-0e1d2c3b4a59';

@ApiSchema({ name: 'StashBalance' })
export class StashBalanceDocument implements StashBalanceView {
  @ApiCurrency()
  currency!: string;

  @ApiMinorUnit()
  minorUnit!: number;

  @ApiProperty({ type: 'string', pattern: '^(0|[1-9]\\d{0,18})$', example: '80000', description: 'Confirmations less reversals, in minor units ("0" when nothing arrived). Never negative.' })
  amount!: string;
}

@ApiSchema({ name: 'Stash' })
export class StashDocument implements StashView {
  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: STASH_ID, description: 'Null until your first withdrawal opens it.' })
  stashId!: string | null;

  @ApiProperty({ enum: [STASH_KIND], example: STASH_KIND })
  kind!: typeof STASH_KIND;

  @ApiProperty({ enum: [true], example: true, description: 'Always true: no real bank is involved.' })
  simulated!: true;

  @ApiProperty({ type: [StashBalanceDocument], description: 'NGN always; another currency once a receipt is in it.' })
  balances!: StashBalanceDocument[];
}

class StashDestinationDocument {
  @ApiProperty({ example: '058' })
  bankCode!: string;

  @ApiProperty({ example: 'Guaranty Trust Bank' })
  bankName!: string;

  @ApiProperty({ example: '******6789', description: 'Only the last four digits are ever shown.' })
  accountNumberMasked!: string;
}

@ApiSchema({ name: 'StashReceipt' })
export class StashReceiptDocument implements StashReceiptView {
  @ApiUuid('The receipt (immutable).', RECEIPT_ID)
  receiptId!: string;

  @ApiProperty({ enum: ['CONFIRMATION', 'REVERSAL'], example: 'CONFIRMATION', description: 'CONFIRMATION: the transfer arrived. REVERSAL: the bank returned it to your wallet.' })
  kind!: StashReceiptKind;

  @ApiProperty({ enum: ['IN', 'OUT'], example: 'IN' })
  direction!: 'IN' | 'OUT';

  @ApiCurrency()
  currency!: string;

  @ApiMinorUnit()
  minorUnit!: number;

  @ApiMinorUnits('The withdrawal\'s principal, always positive.', '80000', MINOR_UNITS_PATTERN_19)
  amount!: string;

  @ApiUuid('The withdrawal.', WITHDRAWAL_ID)
  withdrawalId!: string;

  @ApiProperty({ example: `withdrawal:${WITHDRAWAL_ID}`, description: 'Its `GET /transactions/{reference}`.' })
  withdrawalReference!: string;

  @ApiProperty({ example: `withdrawal-${WITHDRAWAL_ID}`, description: 'The reference the transfer carried at Paystack.' })
  providerReference!: string;

  @ApiProperty({ example: `withdrawal:${WITHDRAWAL_ID}`, description: 'The ledger transaction this receipt records (the withdrawal, or its reversal).' })
  ledgerReference!: string;

  @ApiProperty({ type: StashDestinationDocument })
  destination!: StashDestinationDocument;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: null, description: 'On a REVERSAL: the confirmation it reverses.' })
  reversesReceiptId!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: null, description: 'On a CONFIRMATION: the reversal that later returned it.' })
  reversedByReceiptId!: string | null;

  @ApiInstant('When it happened at the provider (its accounting time).')
  valueTime!: string;

  @ApiInstant('When we recorded the receipt (the sort key).')
  recordedAt!: string;
}

@ApiSchema({ name: 'StashTransactionsPage' })
export class StashTransactionsPageDocument implements StashTransactionsPage {
  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: STASH_ID, description: 'Null until your first withdrawal opens it.' })
  stashId!: string | null;

  @ApiProperty({ enum: [STASH_KIND], example: STASH_KIND })
  kind!: typeof STASH_KIND;

  @ApiProperty({ enum: [true], example: true })
  simulated!: true;

  @ApiProperty({ type: [StashReceiptDocument] })
  items!: StashReceiptDocument[];

  @ApiProperty({ type: 'string', nullable: true, example: null, description: 'Pass it back as `cursor` (with the same `currency`) for the next page.' })
  nextCursor!: string | null;
}
