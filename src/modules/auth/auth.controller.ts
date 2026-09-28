import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AllowUnverified, CurrentUser, Public, RateLimit, RateLimitRule } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/guards/authenticated-request';
import { AccountCreationService } from './account-creation.service';
import {
  REGISTRATION_ACCEPTED,
  SessionResponse,
  TokenPairResponse,
  VERIFICATION_CODE_REQUESTED,
} from './auth.types';
import { LoginDto, RefreshDto, RegisterDto, ResendVerificationCodeDto, VerifyEmailDto } from './dto/auth.dto';
import { LoginService } from './login.service';
import { VerificationService } from './verification.service';

/**
 * Per-email email budget, SHARED by register and resend-otp (same counter names):
 * one code per 60 seconds, five per hour (design §7.1). Keyed by the email, not the
 * account, so the limit behaves identically for unknown emails — no enumeration.
 */
const VERIFICATION_EMAIL_RULES: readonly RateLimitRule[] = [
  { name: 'verification-email-cooldown', subject: 'email', limit: 1, windowSeconds: 60 },
  { name: 'verification-email-hourly', subject: 'email', limit: 5, windowSeconds: 3600 },
];

/**
 * `Idempotency-Key` is not required here (decision #1, a recorded deviation from
 * design §12): every one of these is safe to retry by its own semantics, and scoping
 * anonymous keys would let a guessed key replay someone else's tokens.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly accountCreation: AccountCreationService,
    private readonly verification: VerificationService,
    private readonly login: LoginService,
  ) {}

  @Public()
  @RateLimit({
    rules: [{ name: 'register', subject: 'ip', limit: 10, windowSeconds: 3600 }, ...VERIFICATION_EMAIL_RULES],
    whenUnavailable: 'fail-closed',
  })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() body: RegisterDto): Promise<typeof REGISTRATION_ACCEPTED> {
    await this.accountCreation.register(body.email, body.password);
    return REGISTRATION_ACCEPTED;
  }

  @Public()
  @RateLimit({
    rules: [{ name: 'verify', subject: 'ip-and-email', limit: 10, windowSeconds: 900 }],
    whenUnavailable: 'fail-closed',
  })
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  verify(@Body() body: VerifyEmailDto): Promise<SessionResponse> {
    return this.verification.verifyEmail(body.email, body.password, body.oneTimePassword);
  }

  @Public()
  @RateLimit({ rules: VERIFICATION_EMAIL_RULES, whenUnavailable: 'fail-closed' })
  @Post('resend-otp')
  @HttpCode(HttpStatus.ACCEPTED)
  async resendVerificationCode(@Body() body: ResendVerificationCodeDto): Promise<typeof VERIFICATION_CODE_REQUESTED> {
    await this.verification.resendVerificationCode(body.email);
    return VERIFICATION_CODE_REQUESTED;
  }

  /** design §9.1: 5 per 15 minutes; plus a per-email ceiling against distributed guessing. */
  @Public()
  @RateLimit({
    rules: [
      { name: 'login', subject: 'ip-and-email', limit: 5, windowSeconds: 900 },
      { name: 'login-email', subject: 'email', limit: 20, windowSeconds: 900 },
    ],
    whenUnavailable: 'fail-closed',
  })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  logIn(@Body() body: LoginDto): Promise<SessionResponse> {
    return this.login.login(body.email, body.password);
  }

  /** A 256-bit token can't be guessed: the global per-IP limit suffices, and fails open. */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() body: RefreshDto): Promise<{ tokens: TokenPairResponse }> {
    return this.login.refresh(body.refreshToken);
  }

  /** Revokes the session the access token belongs to. Works for suspended users too. */
  @AllowUnverified()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.login.logout(user.id, user.refreshTokenFamilyId);
  }
}
