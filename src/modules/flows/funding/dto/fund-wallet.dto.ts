import { ApiSchema, ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';
import { ApiCurrency, ApiMinorUnits, MINOR_UNITS_PATTERN_18 } from '../../../../openapi/properties';

/**
 * `POST /wallet/fund` (design §12). The amount is a string of minor units (never a JSON
 * number). The client never sends card data: it sends a single-use token obtained
 * from the PSP's client SDK, so card numbers never reach this API (no PCI scope).
 */
@ApiSchema({ name: 'FundWalletRequest' })
export class FundWalletDto {
  @ApiMinorUnits('How much to fund. Within the currency\'s funding limits (default NGN ₦100 – ₦1,000,000).', '150000', MINOR_UNITS_PATTERN_18, { maxLength: 19 })
  @IsString()
  @MaxLength(19)
  @Matches(/^[1-9]\d{0,17}$/, { message: 'amount must be a positive whole number of minor units, as a string' })
  amount!: string;

  @ApiCurrency('ISO 4217 code of a funding currency (default: NGN only).')
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code' })
  currency!: string;

  @ApiProperty({
    type: 'string',
    pattern: '^[A-Za-z0-9_-]{8,128}$',
    example: 'tok_example_visa',
    description: 'A single-use token from the PSP\'s client SDK. Card data never reaches this API.',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,128}$/, { message: 'paymentMethodToken must be a PSP payment method token' })
  paymentMethodToken!: string;
}
