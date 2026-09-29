import { Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentUser, RateLimit } from '../../common/decorators';
import { RateLimitRule } from '../../common/decorators/rate-limit.decorator';
import { AuthenticatedUser } from '../../common/guards/authenticated-request';
import { ListTransactionsQuery } from './dto/list-transactions.query';
import { TransactionHistoryService, TransactionPage } from './transaction-history.service';
import { TransactionDetailView } from './transaction.view';

/**
 * Per user, shared by both routes (Phase 8 decision 12), on top of the global 100/min/IP. Every
 * page is a bounded index scan, so this caps a client that pages from many addresses.
 */
export const HISTORY_RATE_LIMIT_RULE: RateLimitRule = { name: 'transaction-history', subject: 'user', limit: 120, windowSeconds: 60 };

/**
 * Transaction history (design §7.8, §12). Default guard set — ACTIVE users only (Phase 8
 * decision 9: NOT `@AllowUnverified()`, which would let a suspended user's live session through;
 * an unverified user has no transactions anyway). Scoped by the caller in every WHERE clause.
 * Rate limits fail OPEN: history stays up without Redis (design §16).
 */
@Controller('transactions')
@RateLimit({ rules: [HISTORY_RATE_LIMIT_RULE], whenUnavailable: 'fail-open' })
export class TransactionsController {
  constructor(private readonly history: TransactionHistoryService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListTransactionsQuery): Promise<TransactionPage> {
    return this.history.list({ userId: user.id }, query);
  }

  @Get(':reference')
  find(@CurrentUser() user: AuthenticatedUser, @Param('reference') reference: string): Promise<TransactionDetailView> {
    return this.history.find({ userId: user.id }, reference);
  }
}
