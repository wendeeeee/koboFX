import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

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
export class ConvertDto {
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

  @IsOptional()
  @IsString()
  @MaxLength(19)
  @Matches(MINOR_UNITS, { message: `minimumTargetAmount ${MINOR_UNITS_MESSAGE}` })
  minimumTargetAmount?: string;

  @IsOptional()
  @IsString()
  @MaxLength(19)
  @Matches(MINOR_UNITS, { message: `maximumSourceAmount ${MINOR_UNITS_MESSAGE}` })
  maximumSourceAmount?: string;
}
