import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { ApiAmount, ApiCurrency, ApiDisplayRate, ApiInstant, ApiMinorUnit, ApiUuid } from '../../openapi/properties';
import { EXAMPLE_CLIENT_NGN_USD, EXAMPLE_MID_NGN_USD, EXAMPLE_QUOTE_ID, RateProvenanceDocument } from '../fx/fx.responses';
import { QuoteAmountMode } from '../fx/pricing';
import type { ConversionLegView, ConversionView } from './conversion.view';

/** OpenAPI documentation of the convert/trade body (Phase 11). Never instantiated. */
@ApiSchema({ name: 'ConversionLeg' })
export class ConversionLegDocument implements ConversionLegView {
  @ApiCurrency()
  currency!: string;

  @ApiMinorUnit()
  minorUnit!: number;

  @ApiAmount('Moved on this leg, in this currency\'s minor units.', '153000000')
  amount!: string;
}

@ApiSchema({ name: 'Conversion' })
export class ConversionDocument implements ConversionView {
  @ApiUuid('The ledger transaction.', '2f3e4d5c-6b7a-4980-a1b2-c3d4e5f60718')
  transactionId!: string;

  @ApiProperty({ example: 'conversion:9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d', description: 'Look it up with `GET /transactions/{reference}`.' })
  reference!: string;

  @ApiProperty({ enum: ['CONVERSION'], example: 'CONVERSION' })
  type!: 'CONVERSION';

  @ApiProperty({ enum: ['POSTED'], example: 'POSTED', description: 'Always POSTED: a conversion is booked in the same transaction as the request.' })
  status!: 'POSTED';

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: EXAMPLE_QUOTE_ID, description: 'The quote a trade executed; null for a market conversion.' })
  quoteId!: string | null;

  @ApiProperty({ enum: QuoteAmountMode, enumName: 'AmountMode', example: QuoteAmountMode.SOURCE })
  amountMode!: QuoteAmountMode;

  @ApiProperty({ type: ConversionLegDocument, description: 'Taken from the source currency.' })
  debited!: ConversionLegDocument;

  @ApiProperty({ type: ConversionLegDocument, description: 'Given in the target currency.', example: { currency: 'USD', minorUnit: 2, amount: '98499' } })
  credited!: ConversionLegDocument;

  @ApiDisplayRate('The effective rate, derived from the two amounts (target per source).', '0.000643784313725')
  rateDisplay!: string;

  @ApiDisplayRate('The client rate priced at.', EXAMPLE_CLIENT_NGN_USD)
  clientRate!: string;

  @ApiDisplayRate('The reference mid priced off.', EXAMPLE_MID_NGN_USD)
  midRate!: string;

  @ApiProperty({ type: 'integer', minimum: 0, example: 150 })
  spreadBasisPoints!: number;

  @ApiProperty({ type: RateProvenanceDocument })
  rate!: RateProvenanceDocument;

  @ApiInstant('When it happened (= booking time for a conversion).', '2026-09-29T10:01:37.412Z')
  valueTime!: string;

  @ApiInstant('When it was recorded.', '2026-09-29T10:01:37.412Z')
  bookingTime!: string;
}
