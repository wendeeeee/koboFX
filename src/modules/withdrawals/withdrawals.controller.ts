import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Idempotent, RateLimit } from '../../common/decorators';
import { RateLimitRule } from '../../common/decorators/rate-limit.decorator';
import { ErrorCode } from '../../common/errors';
import { AuthenticatedUser } from '../../common/guards/authenticated-request';
import { ApiErrors } from '../../openapi/api-errors.decorator';
import { BankDirectoryPage, BankDirectoryService } from './bank-directory.service';
import { BeneficiaryAccepted, BeneficiaryPage, BeneficiaryService, BeneficiaryView } from './beneficiary.service';
import { AddBeneficiaryDto, BankListQuery, PageQuery, WithdrawDto } from './dto/withdrawals.dto';
import { WithdrawalAccepted, WithdrawalService, WithdrawalView } from './withdrawal.service';
import {
  BeneficiaryAcceptedDocument,
  BeneficiaryDocument,
  BeneficiaryPageDocument,
  WithdrawalAcceptedDocument,
  WithdrawalBankPageDocument,
  WithdrawalDocument,
} from './withdrawals.responses';

/** Abuse limits per user (WITHDRAWAL_PLAN.md §K) — separate from money limits and idempotency. */
const READS: RateLimitRule = { name: 'withdrawal-reads', subject: 'user', limit: 120, windowSeconds: 60 };
const BENEFICIARY_WRITES: RateLimitRule = { name: 'withdrawal-beneficiary-writes', subject: 'user', limit: 10, windowSeconds: 60 };
const WITHDRAW_WRITES: RateLimitRule = { name: 'withdrawal-writes', subject: 'user', limit: 30, windowSeconds: 60 };

const TEST_MODE =
  ' Paystack TEST mode only: no real bank receives money; a confirmed transfer lands in your simulated-bank stash.';

/**
 * Withdrawals to a Nigerian bank account through Paystack Transfers (WITHDRAWAL_PLAN.md §J). Every route is the
 * caller's own (scoped by the authenticated user in SQL; another user's ids are the same 404). Writes are database-only
 * behind the idempotency barrier; the worker talks to Paystack after they commit. New writes answer `503
 * WITHDRAWALS_DISABLED` while switched off — an earlier request's key still replays its original answer.
 */
@ApiTags('wallet')
@Controller('wallet')
export class WithdrawalsController {
  constructor(
    private readonly banks: BankDirectoryService,
    private readonly beneficiaries: BeneficiaryService,
    private readonly withdrawals: WithdrawalService,
  ) {}

  @Get('withdrawal-banks')
  @RateLimit({ rules: [READS], whenUnavailable: 'fail-open' })
  @ApiOperation({ summary: 'Banks you can withdraw to', description: `Nigerian NGN banks from Paystack's directory, cached (about 5 minutes).${TEST_MODE}` })
  @ApiOkResponse({ type: WithdrawalBankPageDocument })
  @ApiErrors(ErrorCode.INVALID_CURSOR, ErrorCode.WITHDRAWALS_DISABLED, ErrorCode.DEPENDENCY_UNAVAILABLE)
  listBanks(@Query() query: BankListQuery): Promise<BankDirectoryPage> {
    return this.banks.page(query.currency ?? 'NGN', query.cursor, query.limit ? Number(query.limit) : undefined);
  }

  @Post('withdrawal-beneficiaries')
  @HttpCode(HttpStatus.ACCEPTED)
  @Idempotent({ keyedRequestHash: true })
  @RateLimit({ rules: [BENEFICIARY_WRITES], whenUnavailable: 'fail-open' })
  @ApiOperation({
    summary: 'Add a withdrawal beneficiary',
    description:
      'Accepted at once (`202 PENDING`); the worker asks Paystack to resolve the account (the name is Paystack\'s) and ' +
      `creates the transfer recipient. Poll until READY. The same account added again returns the existing beneficiary.${TEST_MODE}`,
  })
  @ApiAcceptedResponse({ type: BeneficiaryAcceptedDocument })
  @ApiErrors(ErrorCode.UNSUPPORTED_CURRENCY, ErrorCode.WITHDRAWALS_DISABLED)
  addBeneficiary(@CurrentUser() user: AuthenticatedUser, @Body() body: AddBeneficiaryDto): Promise<BeneficiaryAccepted> {
    return this.beneficiaries.request(user.id, body);
  }

  @Get('withdrawal-beneficiaries')
  @RateLimit({ rules: [READS], whenUnavailable: 'fail-open' })
  @ApiOperation({ summary: 'My withdrawal beneficiaries', description: 'Newest first, keyset-paginated. Account numbers are masked.' })
  @ApiOkResponse({ type: BeneficiaryPageDocument })
  @ApiErrors(ErrorCode.INVALID_CURSOR)
  listBeneficiaries(@CurrentUser() user: AuthenticatedUser, @Query() query: PageQuery): Promise<BeneficiaryPage> {
    return this.beneficiaries.list(user.id, query.cursor, query.limit ? Number(query.limit) : 50);
  }

  @Get('withdrawal-beneficiaries/:beneficiaryId')
  @RateLimit({ rules: [READS], whenUnavailable: 'fail-open' })
  @ApiOperation({ summary: 'One withdrawal beneficiary', description: 'Status, masked account, and the name Paystack resolved once known.' })
  @ApiOkResponse({ type: BeneficiaryDocument })
  @ApiErrors(ErrorCode.WITHDRAWAL_BENEFICIARY_NOT_FOUND)
  findBeneficiary(@CurrentUser() user: AuthenticatedUser, @Param('beneficiaryId', ParseUUIDPipe) beneficiaryId: string): Promise<BeneficiaryView> {
    return this.beneficiaries.find(user.id, beneficiaryId);
  }

  @Post('withdraw/paystack')
  @HttpCode(HttpStatus.ACCEPTED)
  @Idempotent({ flowIdField: 'withdrawalId' })
  @RateLimit({ rules: [WITHDRAW_WRITES], whenUnavailable: 'fail-open' })
  @ApiOperation({
    summary: 'Withdraw to a beneficiary through Paystack',
    description:
      'Accepted at once (`202 PENDING`) with the amount HELD from your available balance; the worker sends the transfer ' +
      'after this commits. It completes only when Paystack\'s verify API confirms the exact transfer — a webhook alone ' +
      `never does. If Paystack definitively fails it, the hold is released.${TEST_MODE}`,
  })
  @ApiAcceptedResponse({ type: WithdrawalAcceptedDocument })
  @ApiErrors(
    ErrorCode.WITHDRAWAL_BENEFICIARY_NOT_FOUND,
    ErrorCode.BENEFICIARY_NOT_READY,
    ErrorCode.INSUFFICIENT_FUNDS,
    ErrorCode.FUNDS_RESERVED,
    ErrorCode.INVALID_AMOUNT,
    ErrorCode.UNSUPPORTED_CURRENCY,
    ErrorCode.AMOUNT_TOO_SMALL,
    ErrorCode.AMOUNT_TOO_LARGE,
    ErrorCode.DAILY_LIMIT_EXCEEDED,
    ErrorCode.WITHDRAWALS_DISABLED,
  )
  withdraw(@CurrentUser() user: AuthenticatedUser, @Body() body: WithdrawDto): Promise<WithdrawalAccepted> {
    return this.withdrawals.request(user.id, body);
  }

  @Get('withdraw/:withdrawalId')
  @RateLimit({ rules: [READS], whenUnavailable: 'fail-open' })
  @ApiOperation({ summary: 'One withdrawal', description: 'Status, amounts, the frozen destination (masked), and the stash receipt once COMPLETED.' })
  @ApiOkResponse({ type: WithdrawalDocument })
  @ApiErrors(ErrorCode.WITHDRAWAL_NOT_FOUND)
  findWithdrawal(@CurrentUser() user: AuthenticatedUser, @Param('withdrawalId', ParseUUIDPipe) withdrawalId: string): Promise<WithdrawalView> {
    return this.withdrawals.find(user.id, withdrawalId);
  }
}
