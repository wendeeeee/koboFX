import { ApiSchema, ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';
import {
  IsNotDisposableEmail,
  IsSupportedEmailAddress,
  NormalizeEmailAddress,
} from '../../users/validation/email-address.validators';
import { IsAcceptablePassword, MAXIMUM_PASSWORD_LENGTH } from '../passwords/password-policy';


const MAXIMUM_CREDENTIAL_LENGTH = MAXIMUM_PASSWORD_LENGTH * 4;

const EMAIL_DESCRIPTION = 'Trimmed and lower-cased; ASCII only (non-ASCII is refused, never mapped).';
const ApiEmail = (description = EMAIL_DESCRIPTION): PropertyDecorator =>
  ApiProperty({ type: 'string', format: 'email', maxLength: 254, example: 'ada.lovelace@example.com', description });
const ApiCredentialPassword = (): PropertyDecorator =>
  ApiProperty({ type: 'string', maxLength: MAXIMUM_CREDENTIAL_LENGTH, example: 'correct horse battery staple', description: 'The account password.' });

@ApiSchema({ name: 'RegisterRequest' })
export class RegisterDto {
  @ApiEmail(`${EMAIL_DESCRIPTION} Disposable-email domains are refused.`)
  @NormalizeEmailAddress()
  @IsSupportedEmailAddress()
  @IsNotDisposableEmail()
  email!: string;

  @ApiProperty({
    type: 'string',
    minLength: 12,
    maxLength: MAXIMUM_PASSWORD_LENGTH,
    example: 'correct horse battery staple',
    description: '12–128 code points after NFKC normalisation. No composition rules; common and repetitive passwords are refused (NIST 800-63B).',
  })
  @IsString()
  @IsAcceptablePassword()
  password!: string;
}

@ApiSchema({ name: 'VerifyEmailRequest' })
export class VerifyEmailDto {
  @ApiEmail()
  @NormalizeEmailAddress()
  @IsSupportedEmailAddress()
  email!: string;

  @ApiCredentialPassword()
  @IsString()
  @MaxLength(MAXIMUM_CREDENTIAL_LENGTH)
  password!: string;

  @ApiProperty({ type: 'string', pattern: '^\\d{6}$', example: '493817', description: 'The 6-digit code from the verification email (valid 10 minutes).' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'oneTimePassword must be exactly 6 digits' })
  oneTimePassword!: string;
}

@ApiSchema({ name: 'ResendVerificationCodeRequest' })
export class ResendVerificationCodeDto {
  @ApiEmail()
  @NormalizeEmailAddress()
  @IsSupportedEmailAddress()
  email!: string;
}

@ApiSchema({ name: 'LoginRequest' })
export class LoginDto {
  @ApiEmail()
  @NormalizeEmailAddress()
  @IsSupportedEmailAddress()
  email!: string;

  @ApiCredentialPassword()
  @IsString()
  @MaxLength(MAXIMUM_CREDENTIAL_LENGTH)
  password!: string;
}

@ApiSchema({ name: 'RefreshRequest' })
export class RefreshDto {
  @ApiProperty({ type: 'string', maxLength: 256, example: '<refresh-token>', description: 'The opaque refresh token. Single use: presenting a used one revokes the whole session family.' })
  @IsString()
  @MaxLength(256)
  refreshToken!: string;
}
