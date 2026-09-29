import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * `POST /wallet/fund` (design §12). The amount is a string of minor units (never a JSON
 * number). The client never sends card data: it sends a single-use token obtained
 * from the PSP's client SDK, so card numbers never reach this API (no PCI scope).
 */
export class FundWalletDto {
  @IsString()
  @MaxLength(19)
  @Matches(/^[1-9]\d{0,17}$/, { message: 'amount must be a positive whole number of minor units, as a string' })
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code' })
  currency!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,128}$/, { message: 'paymentMethodToken must be a PSP payment method token' })
  paymentMethodToken!: string;
}
