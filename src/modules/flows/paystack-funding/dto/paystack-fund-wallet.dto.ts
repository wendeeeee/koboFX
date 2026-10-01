import { ApiSchema } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';
import { ApiCurrency, ApiMinorUnits, MINOR_UNITS_PATTERN_18 } from '../../../../openapi/properties';

/**
 * `POST /wallet/fund/paystack`. Only what to fund: the amount (a string of minor units, never a JSON number) and the
 * currency. No email (the worker uses the authenticated user's stored one), no reference (it is the funding id), no
 * card data (the customer pays on Paystack's hosted checkout). Unknown fields are refused by the global pipe.
 */
@ApiSchema({ name: 'PaystackFundWalletRequest' })
export class PaystackFundWalletDto {
  @ApiMinorUnits('How much to fund. Within the currency\'s funding limits (default NGN ₦100 – ₦1,000,000).', '150000', MINOR_UNITS_PATTERN_18, { maxLength: 19 })
  @IsString()
  @MaxLength(19)
  @Matches(/^[1-9]\d{0,17}$/, { message: 'amount must be a positive whole number of minor units, as a string' })
  amount!: string;

  @ApiCurrency('ISO 4217 code of a Paystack funding currency (default: NGN only).')
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code' })
  currency!: string;
}
