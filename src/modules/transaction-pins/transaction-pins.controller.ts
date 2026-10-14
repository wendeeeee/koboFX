import { Body, Controller, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { ApiAcceptedResponse, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RateLimit } from '../../common/decorators';
import { RateLimitRule } from '../../common/decorators/rate-limit.decorator';
import { ErrorCode } from '../../common/errors';
import { AuthenticatedUser } from '../../common/guards/authenticated-request';
import { ApiErrors } from '../../openapi/api-errors.decorator';
import { ChangeTransactionPinDto, CreateTransactionPinDto, ResetTransactionPinDto } from './dto/transaction-pin.dto';
import { TransactionPinResetCodeRequested, TransactionPinService, TransactionPinStatus } from './transaction-pin.service';
import { TransactionPinResetCodeRequestedDocument, TransactionPinStatusDocument } from './transaction-pins.responses';

/** Creating, changing and resetting a PIN share one budget per user: they also check a password or a PIN. */
const PIN_WRITES: RateLimitRule = { name: 'transaction-pin-writes', subject: 'user', limit: 10, windowSeconds: 3600 };
/** Reset-code emails: one a minute, five an hour (like every other code email). */
const RESET_CODE_RULES: RateLimitRule[] = [
  { name: 'transaction-pin-reset-code-cooldown', subject: 'user', limit: 1, windowSeconds: 60 },
  { name: 'transaction-pin-reset-code-hourly', subject: 'user', limit: 5, windowSeconds: 3600 },
];

/**
 * The caller's transaction PIN (2026-10-12 decision), the final confirmation of every withdrawal and conversion. The
 * PIN is never returned or echoed; `GET /users/me` says whether one is set or locked. No `Idempotency-Key` here (as
 * on `/auth/*`): create answers `409` once set, and a retried change or reset that already applied answers its success.
 */
@ApiTags('users')
@Controller('users/me/transaction-pin')
export class TransactionPinsController {
  constructor(private readonly pins: TransactionPinService) {}

  @Post()
  @RateLimit({ rules: [PIN_WRITES], whenUnavailable: 'fail-closed' })
  @ApiOperation({
    summary: 'Create my transaction PIN',
    description: 'Six digits, confirmed with your account password. Required before you can withdraw or convert. You get an email when it is created.',
  })
  @ApiCreatedResponse({ type: TransactionPinStatusDocument })
  @ApiErrors(ErrorCode.TRANSACTION_PIN_ALREADY_SET, ErrorCode.TRANSACTION_PIN_TOO_WEAK, ErrorCode.PASSWORD_INCORRECT)
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateTransactionPinDto): Promise<TransactionPinStatus> {
    return this.pins.create(user.id, body.pin, body.password);
  }

  @Put()
  @RateLimit({ rules: [PIN_WRITES], whenUnavailable: 'fail-closed' })
  @ApiOperation({
    summary: 'Change my transaction PIN',
    description: 'Give the current PIN and a new one. A wrong current PIN counts towards the lock (5 wrong in a row lock it until a reset).',
  })
  @ApiOkResponse({ type: TransactionPinStatusDocument })
  @ApiErrors(
    ErrorCode.TRANSACTION_PIN_NOT_SET,
    ErrorCode.TRANSACTION_PIN_INVALID,
    ErrorCode.TRANSACTION_PIN_LOCKED,
    ErrorCode.TRANSACTION_PIN_TOO_WEAK,
  )
  change(@CurrentUser() user: AuthenticatedUser, @Body() body: ChangeTransactionPinDto): Promise<TransactionPinStatus> {
    return this.pins.change(user.id, body.currentPin, body.newPin);
  }

  @Post('reset-code')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit({ rules: RESET_CODE_RULES, whenUnavailable: 'fail-closed' })
  @ApiOperation({
    summary: 'Email me a PIN reset code',
    description: 'For a forgotten or locked PIN. The 6-digit code is valid for 10 minutes; a newer code replaces an older one.',
  })
  @ApiAcceptedResponse({ type: TransactionPinResetCodeRequestedDocument })
  @ApiErrors(ErrorCode.TRANSACTION_PIN_NOT_SET)
  requestResetCode(@CurrentUser() user: AuthenticatedUser): Promise<TransactionPinResetCodeRequested> {
    return this.pins.requestResetCode(user.id);
  }

  @Post('reset')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ rules: [PIN_WRITES], whenUnavailable: 'fail-closed' })
  @ApiOperation({
    summary: 'Reset my transaction PIN',
    description: 'Your account password, the emailed reset code and a new PIN. Unlocks a locked PIN. You get an email when it is reset.',
  })
  @ApiOkResponse({ type: TransactionPinStatusDocument })
  @ApiErrors(
    ErrorCode.TRANSACTION_PIN_NOT_SET,
    ErrorCode.TRANSACTION_PIN_TOO_WEAK,
    ErrorCode.TRANSACTION_PIN_RESET_CODE_INVALID,
    ErrorCode.PASSWORD_INCORRECT,
    ErrorCode.DEPENDENCY_UNAVAILABLE,
  )
  reset(@CurrentUser() user: AuthenticatedUser, @Body() body: ResetTransactionPinDto): Promise<TransactionPinStatus> {
    return this.pins.reset(user.id, body.password, body.oneTimePassword, body.newPin);
  }
}
