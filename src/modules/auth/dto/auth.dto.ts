import { IsString, Matches, MaxLength } from 'class-validator';
import {
  IsNotDisposableEmail,
  IsSupportedEmailAddress,
  NormalizeEmailAddress,
} from '../../users/validation/email-address.validators';
import { IsAcceptablePassword, MAXIMUM_PASSWORD_LENGTH } from '../passwords/password-policy';

/** Bounds a credential string without applying the registration policy (login must accept old passwords). */
const MAXIMUM_CREDENTIAL_LENGTH = MAXIMUM_PASSWORD_LENGTH * 4;

export class RegisterDto {
  @NormalizeEmailAddress()
  @IsSupportedEmailAddress()
  @IsNotDisposableEmail()
  email!: string;

  @IsString()
  @IsAcceptablePassword()
  password!: string;
}

export class VerifyEmailDto {
  @NormalizeEmailAddress()
  @IsSupportedEmailAddress()
  email!: string;

  @IsString()
  @MaxLength(MAXIMUM_CREDENTIAL_LENGTH)
  password!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'oneTimePassword must be exactly 6 digits' })
  oneTimePassword!: string;
}

export class ResendVerificationCodeDto {
  @NormalizeEmailAddress()
  @IsSupportedEmailAddress()
  email!: string;
}

export class LoginDto {
  @NormalizeEmailAddress()
  @IsSupportedEmailAddress()
  email!: string;

  @IsString()
  @MaxLength(MAXIMUM_CREDENTIAL_LENGTH)
  password!: string;
}

export class RefreshDto {
  @IsString()
  @MaxLength(256)
  refreshToken!: string;
}
