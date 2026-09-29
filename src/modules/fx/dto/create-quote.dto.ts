import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const MINOR_UNITS = /^[1-9]\d{0,18}$/;
const MINOR_UNITS_MESSAGE = 'must be a positive whole number of minor units, as a string';

/**
 * `POST /fx/quotes` (design §7.7, §12). Directional: `from` is sold, `to` is bought. Give
 * EXACTLY ONE of `sourceAmount` (how much `from` to sell) or `targetAmount` (how much
 * `to` to receive — "buy $50 with NGN"). Amounts are strings of minor units, never JSON
 * numbers.
 */
export class CreateQuoteDto {
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'from must be an ISO 4217 code' })
  from!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'to must be an ISO 4217 code' })
  to!: string;

  @IsOptional()
  @IsString()
  @MaxLength(19)
  @Matches(MINOR_UNITS, { message: `sourceAmount ${MINOR_UNITS_MESSAGE}` })
  sourceAmount?: string;

  @IsOptional()
  @IsString()
  @MaxLength(19)
  @Matches(MINOR_UNITS, { message: `targetAmount ${MINOR_UNITS_MESSAGE}` })
  targetAmount?: string;
}
