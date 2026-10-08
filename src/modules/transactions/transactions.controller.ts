import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RateLimit } from '../../common/decorators';
import { ErrorCode } from '../../common/errors';
import { ApiErrors } from '../../openapi/api-errors.decorator';
import { RateLimitRule } from '../../common/decorators/rate-limit.decorator';
import { AuthenticatedUser } from '../../common/guards/authenticated-request';
import { ListTransactionsQuery } from './dto/list-transactions.query';
import { TransactionHistoryService, TransactionPage } from './transaction-history.service';
import { TransactionDetailView } from './transaction.view';
import { TRANSACTION_REFERENCE_PATTERN } from './reference';
import { TransactionDetailDocument, TransactionPageDocument } from './transactions.responses';

export const ApiTransactionReference = (): MethodDecorator =>
  ApiParam({
    name: 'reference',
    schema: { type: 'string', pattern: TRANSACTION_REFERENCE_PATTERN },
    example: 'funding:3c9a1f2e-7b4d-4e6a-9f80-1a2b3c4d5e6f',
    description: 'A reference (`{kind}:{uuid}`, the colon raw or `%3A`) or a bare transaction id. Anything else is `400 VALIDATION_FAILED`.',
  });


export const HISTORY_RATE_LIMIT_RULE: RateLimitRule = { name: 'transaction-history', subject: 'user', limit: 120, windowSeconds: 60 };


@ApiTags('transactions')
@Controller('transactions')
@RateLimit({ rules: [HISTORY_RATE_LIMIT_RULE], whenUnavailable: 'fail-open' })
export class TransactionsController {
  constructor(private readonly history: TransactionHistoryService) {}

  @Get()
  @ApiOperation({
    summary: 'My transaction history',
    description:
      'Keyset-paginated, newest first, by value time (default) or booking time (design §7.8). Includes fundings that ' +
      'never posted (PENDING / FAILED, under the reference they will get). Value-time traversal: rows landing behind ' +
      'your cursor (a backdated chargeback) are not seen — refresh from the top. Booking-time "never miss a row": ' +
      're-read from `lastSeenBookingTime − 10s` and dedupe by `reference`.',
  })
  @ApiOkResponse({ type: TransactionPageDocument })
  @ApiErrors(ErrorCode.INVALID_CURSOR, ErrorCode.UNSUPPORTED_CURRENCY)
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListTransactionsQuery): Promise<TransactionPage> {
    return this.history.list({ userId: user.id }, query);
  }

  @Get(':reference')
  @ApiOperation({
    summary: 'One transaction',
    description: 'Your own legs with balances after, the stored rate provenance, and correction links both ways. Unknown and another user\'s are the same 404.',
  })
  @ApiTransactionReference()
  @ApiOkResponse({ type: TransactionDetailDocument })
  @ApiErrors(ErrorCode.TRANSACTION_NOT_FOUND)
  find(@CurrentUser() user: AuthenticatedUser, @Param('reference') reference: string): Promise<TransactionDetailView> {
    return this.history.find({ userId: user.id }, reference);
  }
}
