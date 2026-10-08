import { ApiSchema } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ApiCurrency, ApiMinorUnits, MINOR_UNITS_PATTERN_19 } from '../../../openapi/properties';

const MINOR_UNITS = /^[1-9]\d{0,18}$/;
const MINOR_UNITS_MESSAGE = 'must be a positive whole number of minor units, as a string';

@ApiSchema({ name: 'CreateQuoteRequest' })
export class CreateQuoteDto {
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

  @ApiMinorUnits('How much `to` to receive ("buy $50 with NGN"). Give exactly one of `sourceAmount` / `targetAmount`.', '5000', MINOR_UNITS_PATTERN_19, { required: false, maxLength: 19 })
  @IsOptional()
  @IsString()
  @MaxLength(19)
  @Matches(MINOR_UNITS, { message: `targetAmount ${MINOR_UNITS_MESSAGE}` })
  targetAmount?: string;
}
