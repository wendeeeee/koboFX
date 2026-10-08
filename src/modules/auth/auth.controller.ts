import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiAcceptedResponse, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowUnverified, CurrentUser, Public, RateLimit, RateLimitRule } from '../../common/decorators';
import { ErrorCode } from '../../common/errors';
import { AuthenticatedUser } from '../../common/guards/authenticated-request';
import { ApiErrors } from '../../openapi/api-errors.decorator';
import { AccountCreationService } from './account-creation.service';
import { RefreshResponseDocument, SessionResponseDocument, UniformMessageDocument } from './auth.responses';
import {
  REGISTRATION_ACCEPTED,
  SessionResponse,
  TokenPairResponse,
  VERIFICATION_CODE_REQUESTED,
} from './auth.types';
import { LoginDto, RefreshDto, RegisterDto, ResendVerificationCodeDto, VerifyEmailDto } from './dto/auth.dto';
import { LoginService } from './login.service';
import { VerificationService } from './verification.service';


const VERIFICATION_EMAIL_RULES: readonly RateLimitRule[] = [
  { name: 'verification-email-cooldown', subject: 'email', limit: 1, windowSeconds: 60 },
  { name: 'verification-email-hourly', subject: 'email', limit: 5, windowSeconds: 3600 },
];


@ApiTags('auth')
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
  @ApiOperation({
    summary: 'Register',
    description:
      'Creates the user, wallet and NGN account and emails a 6-digit code.',
  })
  @ApiCreatedResponse({ type: UniformMessageDocument, description: 'Accepted (uniform body).' })
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
  @ApiOperation({
    summary: 'Verify the email and start a session',
    description:
      'Takes the email, the password AND the code' +
      'Activates the account and returns a session.',
  })
  @ApiOkResponse({ type: SessionResponseDocument })
  @ApiErrors(ErrorCode.VERIFICATION_FAILED)
  verify(@Body() body: VerifyEmailDto): Promise<SessionResponse> {
    return this.verification.verifyEmail(body.email, body.password, body.oneTimePassword);
  }

  @Public()
  @RateLimit({ rules: VERIFICATION_EMAIL_RULES, whenUnavailable: 'fail-closed' })
  @Post('resend-otp')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Resend the verification code',
    description: 'Supersedes the previous code.',
  })
  @ApiAcceptedResponse({ type: UniformMessageDocument, description: 'Accepted (uniform body).' })
  async resendVerificationCode(@Body() body: ResendVerificationCodeDto): Promise<typeof VERIFICATION_CODE_REQUESTED> {
    await this.verification.resendVerificationCode(body.email);
    return VERIFICATION_CODE_REQUESTED;
  }

 
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
  @ApiOperation({
    summary: 'Log in',
    description: 'Log in to your account',
  })
  @ApiOkResponse({ type: SessionResponseDocument })
  @ApiErrors(ErrorCode.INVALID_CREDENTIALS)
  logIn(@Body() body: LoginDto): Promise<SessionResponse> {
    return this.login.login(body.email, body.password);
  }


  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the session tokens',
    description:
      '',
  })
  @ApiOkResponse({ type: RefreshResponseDocument })
  @ApiErrors(ErrorCode.UNAUTHENTICATED)
  refresh(@Body() body: RefreshDto): Promise<{ tokens: TokenPairResponse }> {
    return this.login.refresh(body.refreshToken);
  }


  @AllowUnverified()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Log out', description: 'Revokes the session (refresh token family) the access token belongs to. Works for unverified and suspended users too.' })
  @ApiNoContentResponse({ description: 'Revoked. No body.' })
  async logout(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.login.logout(user.id, user.refreshTokenFamilyId);
  }
}
