import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

const PIN = '^\\d{6}$';
const pinProperty = (description: string) =>
  ApiProperty({ type: 'string', pattern: PIN, example: '402815', description: `${description} Six digits; not all the same digit, not a straight sequence.` });

@ApiSchema({ name: 'CreateTransactionPinRequest' })
export class CreateTransactionPinDto {
  @pinProperty('Your new transaction PIN.')
  @IsString()
  @Matches(/^\d{6}$/, { message: 'pin must be exactly 6 digits' })
  pin!: string;

  @ApiProperty({ type: 'string', format: 'password', example: '<your account password>', description: 'Your account password, to confirm it is you.' })
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  password!: string;
}

@ApiSchema({ name: 'ChangeTransactionPinRequest' })
export class ChangeTransactionPinDto {
  @ApiProperty({ type: 'string', pattern: PIN, example: '402815', description: 'Your current transaction PIN (a wrong one counts towards the lock).' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'currentPin must be exactly 6 digits' })
  currentPin!: string;

  @pinProperty('Your new transaction PIN (must differ from the current one).')
  @IsString()
  @Matches(/^\d{6}$/, { message: 'newPin must be exactly 6 digits' })
  newPin!: string;
}

@ApiSchema({ name: 'ResetTransactionPinRequest' })
export class ResetTransactionPinDto {
  @ApiProperty({ type: 'string', format: 'password', example: '<your account password>', description: 'Your account password.' })
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  password!: string;

  @ApiProperty({ type: 'string', pattern: PIN, example: '518204', description: 'The 6-digit code emailed by `POST /users/me/transaction-pin/reset-code`.' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'oneTimePassword must be the 6-digit code from your email' })
  oneTimePassword!: string;

  @pinProperty('Your new transaction PIN.')
  @IsString()
  @Matches(/^\d{6}$/, { message: 'newPin must be exactly 6 digits' })
  newPin!: string;
}
