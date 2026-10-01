import { ApiSchema } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ApiCurrency, ApiMinorUnits, MINOR_UNITS_PATTERN_19 } from '../../../openapi/properties';

const MINOR_UNITS = /^[1-9]\d{0,18}$/;
const MINOR_UNITS_MESSAGE = 'must be a positive whole number of minor units, as a string';

/**
 * `POST /wallet/convert` — a market conversion priced at execution (design §7.7), in the
 * quote shape (Phase 6 decision 10): sell `from`, buy `to`, EXACTLY ONE of `sourceAmount`
 * (how much `from` to sell) or `targetAmount` (how much `to` to receive).
 *
 * Price protection replaces §7.7's `maxSlippageBps` (Phase 7 decision): optional, and only
 * the bound matching the mode — `minimumTargetAmount` with `sourceAmount`, or
 * `maximumSourceAmount` with `targetAmount`. Breached ⇒ `409 PRICE_LIMIT_EXCEEDED`.
 * Amounts are strings of minor units, never JSON numbers.
 */
@ApiSchema({ name: 'ConvertRequest' })
export class ConvertDto {
  @ApiCurrency('Sold (debited).', 'NGN')
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'from must be an ISO 4217 code' })
  from!: string;

  @ApiCurrency('Bought (credited). Must differ from `from`.', 'USD')
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'to must be an ISO 4217 code' })
  to!: string;

  @ApiMinorUnits('How much `from` to sell. Give exactly one of `sourceAmount` / `targetAmount`.', '153000000', MINOR_UNITS_PATTERN_19, { required: false, maxLength: 19 })
  @IsOptional()
  @IsString()
  @MaxLength(19)
  @Matches(MINOR_UNITS, { message: `sourceAmount ${MINOR_UNITS_MESSAGE}` })
  sourceAmount?: string;

  @ApiMinorUnits('How much `to` to receive. Give exactly one of `sourceAmount` / `targetAmount`.', '5000', MINOR_UNITS_PATTERN_19, { required: false, maxLength: 19 })
  @IsOptional()
  @IsString()
  @MaxLength(19)
  @Matches(MINOR_UNITS, { message: `targetAmount ${MINOR_UNITS_MESSAGE}` })
  targetAmount?: string;

  @ApiMinorUnits('Price protection with `sourceAmount` only: refuse (`409 PRICE_LIMIT_EXCEEDED`) if the credit would be smaller.', '98000', MINOR_UNITS_PATTERN_19, { required: false, maxLength: 19 })
  @IsOptional()
  @IsString()
  @MaxLength(19)
  @Matches(MINOR_UNITS, { message: `minimumTargetAmount ${MINOR_UNITS_MESSAGE}` })
  minimumTargetAmount?: string;

  @ApiMinorUnits('Price protection with `targetAmount` only: refuse (`409 PRICE_LIMIT_EXCEEDED`) if the debit would be larger.', '7800000', MINOR_UNITS_PATTERN_19, { required: false, maxLength: 19 })
  @IsOptional()
  @IsString()
  @MaxLength(19)
  @Matches(MINOR_UNITS, { message: `maximumSourceAmount ${MINOR_UNITS_MESSAGE}` })
  maximumSourceAmount?: string;
}
