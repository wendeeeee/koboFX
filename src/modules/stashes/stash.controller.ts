import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RateLimit } from '../../common/decorators';
import { RateLimitRule } from '../../common/decorators/rate-limit.decorator';
import { ErrorCode } from '../../common/errors';
import { AuthenticatedUser } from '../../common/guards/authenticated-request';
import { ApiErrors } from '../../openapi/api-errors.decorator';
import { StashTransactionsQuery } from './dto/stash.dto';
import { StashService, StashTransactionsPage, StashView } from './stash.service';
import { StashDocument, StashTransactionsPageDocument } from './stash.responses';

/** 120 reads per minute per user, shared by both stash routes (WITHDRAWAL_PLAN.md §K). */
export const STASH_READS: RateLimitRule = { name: 'stash-reads', subject: 'user', limit: 120, windowSeconds: 60 };

const SIMULATED =
  ' The stash is a SIMULATED bank account (Paystack TEST mode): it shows what a real bank would have received. ' +
  'It is not part of your wallet and can never be spent, converted or withdrawn.';

/**
 * The caller's simulated-bank stash (WITHDRAWAL_PLAN.md §J). Read-only; the default guards (ACTIVE users only) and every
 * query scoped to the caller in SQL. Receipts are immutable: a returned transfer appends a REVERSAL, never edits.
 */
@ApiTags('stash')
@Controller('stash')
export class StashController {
  constructor(private readonly stash: StashService) {}

  @Get()
  @RateLimit({ rules: [STASH_READS], whenUnavailable: 'fail-open' })
  @ApiOperation({ summary: 'My stash balance', description: `Confirmed withdrawals less returned ones, per currency.${SIMULATED}` })
  @ApiOkResponse({ type: StashDocument })
  view(@CurrentUser() user: AuthenticatedUser): Promise<StashView> {
    return this.stash.view(user.id);
  }

  @Get('transactions')
  @RateLimit({ rules: [STASH_READS], whenUnavailable: 'fail-open' })
  @ApiOperation({ summary: 'My stash receipts', description: `Newest first (by when each receipt was recorded), keyset-paginated.${SIMULATED}` })
  @ApiOkResponse({ type: StashTransactionsPageDocument })
  @ApiErrors(ErrorCode.INVALID_CURSOR, ErrorCode.UNSUPPORTED_CURRENCY)
  transactions(@CurrentUser() user: AuthenticatedUser, @Query() query: StashTransactionsQuery): Promise<StashTransactionsPage> {
    return this.stash.transactions(user.id, query);
  }
}
