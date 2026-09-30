import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { IsEnum, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import { RateLimit, Roles } from '../../../common/decorators';
import { BreakSeverity, BreakType } from '../../reconciliation/break-types';
import { ListTransactionsQuery } from '../../transactions/dto/list-transactions.query';
import { TransactionHistoryService } from '../../transactions/transaction-history.service';
import { AdminTransactionView } from '../../transactions/transaction.view';
import { UserRole } from '../../users/user.types';
import { ADMIN_READ_RATE_LIMIT_RULE } from '../approvals/approvals.controller';
import { PositionsService, PositionsView } from '../positions/positions.service';
import { AdminPage, pageSizeOf } from './admin-cursor';
import {
  AdminReadsService,
  AdminUserView,
  BreakDetailView,
  BreakView,
  RecertificationReport,
  RunDetailView,
  RunView,
  parseBreakStatusFilter,
} from './admin-reads.service';

export class ListBreaksQuery {
  @IsOptional()
  @IsIn(['LIVE', 'OPEN', 'ESCALATED', 'RESOLVED'])
  status?: string;

  @IsOptional()
  @IsEnum(BreakType)
  type?: BreakType;

  @IsOptional()
  @IsIn(['MONEY', 'SECURITY', 'INVESTIGATE'])
  severity?: BreakSeverity;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsOptional()
  @IsString()
  @Length(1, 256)
  cursor?: string;

  @IsOptional()
  @Matches(/^\d{1,3}$/)
  limit?: string;
}

export class ListRunsQuery {
  @IsOptional()
  @IsIn(['INTERNAL', 'EXTERNAL_DAILY', 'EXTERNAL_HOURLY'])
  kind?: string;

  @IsOptional()
  @IsString()
  @Length(1, 256)
  cursor?: string;

  @IsOptional()
  @Matches(/^\d{1,3}$/)
  limit?: string;
}

const READS = { rules: [ADMIN_READ_RATE_LIMIT_RULE], whenUnavailable: 'fail-open' } as const;

/**
 * Admin reads (design §12, §15 item 2; Phase 10 plan §E.9). Deny by default: class-level `@Roles(ADMIN, SECURITY)`;
 * recertification is SECURITY's. Read-only, no provider call, ids and codes only — never an email.
 */
@Controller('admin')
@Roles(UserRole.ADMIN, UserRole.SECURITY)
@RateLimit(READS)
export class AdminReadsController {
  constructor(
    private readonly reads: AdminReadsService,
    private readonly positionsService: PositionsService,
    private readonly history: TransactionHistoryService,
  ) {}

  /** FX position per currency (marked to the reference rate) + the trial balance per currency. */
  @Get('positions')
  positions(): Promise<PositionsView> {
    return this.positionsService.positions();
  }

  @Get('breaks')
  breaks(@Query() query: ListBreaksQuery): Promise<AdminPage<BreakView>> {
    return this.reads.breaks(
      {
        status: parseBreakStatusFilter(query.status),
        type: query.type ?? null,
        severity: query.severity ?? null,
        currency: query.currency ?? null,
      },
      query.cursor,
      pageSizeOf(query.limit),
    );
  }

  @Get('breaks/:breakId')
  breakDetail(@Param('breakId', new ParseUUIDPipe()) breakId: string): Promise<BreakDetailView> {
    return this.reads.breakDetail(breakId);
  }

  @Get('reconciliation-runs')
  runs(@Query() query: ListRunsQuery): Promise<AdminPage<RunView>> {
    return this.reads.runs(query.kind ?? null, query.cursor, pageSizeOf(query.limit));
  }

  @Get('reconciliation-runs/:runId')
  runDetail(@Param('runId', new ParseUUIDPipe()) runId: string): Promise<RunDetailView> {
    return this.reads.runDetail(runId);
  }

  @Get('users/:userId')
  user(@Param('userId', new ParseUUIDPipe()) userId: string): Promise<AdminUserView> {
    return this.reads.user(userId);
  }

  /** A user's history with every leg (internal accounts included) and the internal fields. */
  @Get('users/:userId/transactions')
  async userTransactions(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Query() query: ListTransactionsQuery,
  ): Promise<{ items: readonly AdminTransactionView[]; nextCursor: string | null }> {
    await this.reads.user(userId);
    return this.history.listForAdmin(userId, query);
  }

  @Get('users/:userId/transactions/:reference')
  async userTransaction(@Param('userId', new ParseUUIDPipe()) userId: string, @Param('reference') reference: string): Promise<AdminTransactionView> {
    await this.reads.user(userId);
    return this.history.findForAdmin(userId, reference);
  }

  @Get('recertification')
  @Roles(UserRole.SECURITY)
  recertification(): Promise<RecertificationReport> {
    return this.reads.recertification();
  }
}
