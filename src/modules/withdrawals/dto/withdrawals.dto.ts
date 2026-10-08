import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { ApiCurrency, ApiMinorUnits, MINOR_UNITS_PATTERN_18 } from '../../../openapi/properties';

const LIMIT_PATTERN = /^(100|[1-9]\d?)$/;

@ApiSchema({ name: 'AddWithdrawalBeneficiaryRequest' })
export class AddBeneficiaryDto {
  @ApiProperty({ type: 'string', pattern: '^[0-9A-Za-z]{1,20}$', example: '058', description: 'A bank code from `GET /wallet/withdrawal-banks` (leading zeroes kept).' })
  @IsString()
  @Matches(/^[0-9A-Za-z]{1,20}$/, { message: 'bankCode must be a bank code from the withdrawal bank list' })
  bankCode!: string;

  @ApiProperty({ type: 'string', pattern: '^\\d{10}$', example: '0123456789', description: 'A 10-digit Nigerian (NUBAN) account number. Paystack resolves the name; you never send one.' })
  @IsString()
  @Matches(/^\d{10}$/, { message: 'accountNumber must be exactly ten digits' })
  accountNumber!: string;

  @ApiCurrency('Withdrawals are NGN only.')
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code' })
  currency!: string;
}

@ApiSchema({ name: 'PaystackWithdrawRequest' })
export class WithdrawDto {
  @ApiProperty({ type: 'string', format: 'uuid', example: '6a1f9c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b', description: 'A READY beneficiary of yours.' })
  @IsUUID('all', { message: 'beneficiaryId must be a UUID' })
  beneficiaryId!: string;

  @ApiMinorUnits('How much to withdraw. Within the configured withdrawal limits.', '300000', MINOR_UNITS_PATTERN_18, { maxLength: 19 })
  @IsString()
  @MaxLength(19)
  @Matches(/^[1-9]\d{0,17}$/, { message: 'amount must be a positive whole number of minor units, as a string' })
  amount!: string;

  @ApiCurrency('Withdrawals are NGN only.')
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code' })
  currency!: string;

  @ApiProperty({
    type: 'string',
    pattern: '^\\d{6}$',
    example: '123456',
    description: 'The 6-digit code emailed by `POST /wallet/withdraw/one-time-password`. Valid 10 minutes for ONE withdrawal.',
  })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'oneTimePassword must be the 6-digit code from your email' })
  oneTimePassword!: string;
}

export class PageQuery {
  @ApiPropertyOptional({ maxLength: 512, description: 'The previous page\'s `nextCursor`.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ type: 'string', pattern: LIMIT_PATTERN.source, example: '50', description: 'Page size, 1–100 (default 50). Digits only.' })
  @IsOptional()
  @IsString()
  @Matches(LIMIT_PATTERN, { message: 'limit must be a whole number from 1 to 100' })
  limit?: string;
}

export class BankListQuery extends PageQuery {
  @ApiPropertyOptional({ pattern: '^[A-Z]{3}$', example: 'NGN', description: 'Only NGN has withdrawal banks (default NGN).' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code' })
  currency?: string;
}
