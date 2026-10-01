import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { ApiAmount, ApiCurrency, ApiDisplayRate, ApiInstant, ApiUuid } from '../../openapi/properties';
import { QuoteAmountMode } from './pricing';
import { PairRateView, RATE_ATTRIBUTION, RatesView } from './fx-rates.view';
import type { QuoteStatus, QuoteView } from './quote.service';

/** OpenAPI documentation of the FX bodies (Phase 11). Never instantiated. Example figures: USD/NGN 1,530, 150 bps. */
export const EXAMPLE_SNAPSHOT_ID = '5e4d3c2b-1a09-4f8e-a7d6-c5b4a3928170';
export const EXAMPLE_QUOTE_ID = '7d6c5b4a-3928-4170-8e5d-4c3b2a190807';
export const EXAMPLE_MID_NGN_USD = '0.000653594771242';
export const EXAMPLE_CLIENT_NGN_USD = '0.000643790849673';

@ApiSchema({ name: 'RateAttribution' })
export class RateAttributionDocument {
  @ApiProperty({ enum: [RATE_ATTRIBUTION.text], example: RATE_ATTRIBUTION.text })
  text!: typeof RATE_ATTRIBUTION.text;

  @ApiProperty({ enum: [RATE_ATTRIBUTION.url], format: 'uri', example: RATE_ATTRIBUTION.url })
  url!: typeof RATE_ATTRIBUTION.url;
}

@ApiSchema({ name: 'PairRate' })
export class PairRateDocument implements PairRateView {
  @ApiCurrency('Sold.', 'NGN')
  from!: string;

  @ApiCurrency('Bought.', 'USD')
  to!: string;

  @ApiDisplayRate('Reference mid: `to` per 1 `from`.', EXAMPLE_MID_NGN_USD)
  midRate!: string;

  @ApiDisplayRate('What a quote from → to prices at: `mid × (1 − spread)`.', EXAMPLE_CLIENT_NGN_USD)
  clientRate!: string;

  @ApiProperty({ type: 'integer', minimum: 0, example: 150, description: 'The spread in basis points (1 bp = 0.01%).' })
  spreadBasisPoints!: number;

  @ApiAmount('The smallest source amount a quote or conversion accepts, in `from` minor units.', '100000')
  minimumSourceAmount!: string;
}

@ApiSchema({ name: 'Rates' })
export class RatesDocument implements RatesView {
  @ApiProperty({ example: 'exchange-rate-api', description: 'Where the snapshot came from (`manual` for an approved manual rate).' })
  provider!: string;

  @ApiUuid('The snapshot served (provenance).', EXAMPLE_SNAPSHOT_ID)
  snapshotId!: string;

  @ApiInstant('When the provider published these rates (the rate\'s own time).', '2026-09-29T10:00:00.000Z')
  asOf!: string;

  @ApiInstant('When we fetched them.', '2026-09-29T10:00:41.000Z')
  fetchedAt!: string;

  @ApiProperty({ type: 'integer', minimum: 0, example: 95, description: 'The rate\'s true age from `asOf`, in seconds, rounded up.' })
  rateAgeSeconds!: number;

  @ApiProperty({ example: false, description: 'True: may be shown, but quotes and conversions are refused (`503 FX_RATE_STALE`).' })
  stale!: boolean;

  @ApiProperty({ type: RateAttributionDocument, description: 'Required by the provider\'s terms wherever the rates are shown.' })
  attribution!: RateAttributionDocument;

  @ApiProperty({ type: [PairRateDocument], description: 'Every active directional pair; both directions, each with its own client rate.' })
  pairs!: PairRateDocument[];
}

@ApiSchema({ name: 'RateProvenance' })
export class RateProvenanceDocument {
  @ApiProperty({ example: 'exchange-rate-api' })
  provider!: string;

  @ApiInstant('The provider\'s publication time of the rate priced off.', '2026-09-29T10:00:00.000Z')
  asOf!: string;

  @ApiInstant('When we fetched it.', '2026-09-29T10:00:41.000Z')
  fetchedAt!: string;

  @ApiUuid('The rate snapshot priced off.', EXAMPLE_SNAPSHOT_ID)
  snapshotId!: string;
}

@ApiSchema({ name: 'Quote' })
export class QuoteDocument implements QuoteView {
  @ApiUuid('Execute with `POST /wallet/trade`.', EXAMPLE_QUOTE_ID)
  quoteId!: string;

  @ApiCurrency('Sold.', 'NGN')
  from!: string;

  @ApiCurrency('Bought.', 'USD')
  to!: string;

  @ApiProperty({
    enum: QuoteAmountMode,
    enumName: 'AmountMode',
    example: QuoteAmountMode.SOURCE,
    description: 'SOURCE: you fixed what you sell (the credit is rounded down). TARGET: you fixed what you receive (the debit is rounded up).',
  })
  amountMode!: QuoteAmountMode;

  @ApiAmount('What will be debited, in `from` minor units. Locked.', '153000000')
  sourceAmount!: string;

  @ApiAmount('What will be credited, in `to` minor units. Locked.', '98499')
  targetAmount!: string;

  @ApiDisplayRate('Reference mid at pricing.', EXAMPLE_MID_NGN_USD)
  midRate!: string;

  @ApiDisplayRate('Client rate at pricing.', EXAMPLE_CLIENT_NGN_USD)
  clientRate!: string;

  @ApiProperty({ type: 'integer', minimum: 0, example: 150 })
  spreadBasisPoints!: number;

  @ApiProperty({ type: RateProvenanceDocument })
  rate!: RateProvenanceDocument;

  @ApiInstant('Issued.', '2026-09-29T10:01:36.000Z')
  issuedAt!: string;

  @ApiInstant('Executable strictly before this (30 seconds after issue).', '2026-09-29T10:02:06.000Z')
  expiresAt!: string;

  @ApiProperty({ enum: ['OPEN', 'CONSUMED', 'EXPIRED'], example: 'OPEN', description: 'Single use: CONSUMED once traded.' })
  status!: QuoteStatus;
}
