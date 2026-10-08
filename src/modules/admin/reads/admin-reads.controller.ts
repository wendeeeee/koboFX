import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import { RateLimit, Roles } from '../../../common/decorators';
import { ErrorCode } from '../../../common/errors';
import { ApiErrors } from '../../../openapi/api-errors.decorator';
import { ApiTransactionReference } from '../../transactions/transactions.controller';
import { AdminTransactionDocument, AdminTransactionPageDocument } from '../../transactions/transactions.responses';
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
import {
  AdminUserDocument,
  BreakDetailDocument,
  BreakPageDocument,
  PositionsDocument,
  RecertificationDocument,
  RunDetailDocument,
  RunPageDocument,
} from './admin-reads.responses';

const CURSOR_PROPERTY = ApiPropertyOptional({ minLength: 1, maxLength: 256, description: 'The previous page\'s `nextCursor` (same filters).' });
const LIMIT_PROPERTY = ApiPropertyOptional({ type: 'string', pattern: '^\\d{1,3}$', example: '50', description: 'Page size, 1–100 (default 50).' });

export class ListBreaksQuery {
  @ApiPropertyOptional({ enum: ['LIVE', 'OPEN', 'ESCALATED', 'RESOLVED'], description: '`LIVE` = OPEN or ESCALATED.' })
  @IsOptional()
  @IsIn(['LIVE', 'OPEN', 'ESCALATED', 'RESOLVED'])
  status?: string;

  @ApiPropertyOptional({ enum: BreakType, enumName: 'BreakType' })
  @IsOptional()
  @IsEnum(BreakType)
  type?: BreakType;

  @ApiPropertyOptional({ enum: ['MONEY', 'SECURITY', 'INVESTIGATE'] })
  @IsOptional()
  @IsIn(['MONEY', 'SECURITY', 'INVESTIGATE'])
  severity?: BreakSeverity;

  @ApiPropertyOptional({ pattern: '^[A-Z]{3}$', example: 'NGN' })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @CURSOR_PROPERTY
  @IsOptional()
  @IsString()
  @Length(1, 256)
  cursor?: string;

  @LIMIT_PROPERTY
  @IsOptional()
  @Matches(/^\d{1,3}$/)
  limit?: string;
}

export class ListRunsQuery {
  @ApiPropertyOptional({ enum: ['INTERNAL', 'EXTERNAL_DAILY', 'EXTERNAL_HOURLY'] })
  @IsOptional()
  @IsIn(['INTERNAL', 'EXTERNAL_DAILY', 'EXTERNAL_HOURLY'])
  kind?: string;

  @CURSOR_PROPERTY
  @IsOptional()
  @IsString()
  @Length(1, 256)
  cursor?: string;

  @LIMIT_PROPERTY
  @IsOptional()
  @Matches(/^\d{1,3}$/)
  limit?: string;
}

const READS = { rules: [ADMIN_READ_RATE_LIMIT_RULE], whenUnavailable: 'fail-open' } as const;

/**
 * Admin reads (design §12, §15 item 2; Phase 10 plan §E.9). Deny by default: class-level `@Roles(ADMIN, SECURITY)`;
 * recertification is SECURITY's. Read-only, no provider call, ids and codes only — never an email.
 */
@ApiTags('admin-reads')
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
  @ApiOperation({
    summary: 'FX positions and trial balance',
    description: 'FX_POSITION per currency (long positive), marked to USD at the latest servable snapshot (stale/halted still marked, flagged), and the trial balance + accounting equation per currency.',
  })
  @ApiOkResponse({ type: PositionsDocument })
  positions(): Promise<PositionsView> {
    return this.positionsService.positions();
  }

  @Get('breaks')
  @ApiOperation({ summary: 'Reconciliation breaks', description: 'Newest first (keyset on detection time, id).' })
  @ApiOkResponse({ type: BreakPageDocument })
  @ApiErrors(ErrorCode.INVALID_CURSOR)
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
  @ApiOperation({ summary: 'A break', description: 'With its evidence, findings, approvals and audit trail.' })
  @ApiParam({ name: 'breakId', format: 'uuid' })
  @ApiOkResponse({ type: BreakDetailDocument })
  @ApiErrors(ErrorCode.RECONCILIATION_BREAK_NOT_FOUND)
  breakDetail(@Param('breakId', new ParseUUIDPipe()) breakId: string): Promise<BreakDetailView> {
    return this.reads.breakDetail(breakId);
  }

  @Get('reconciliation-runs')
  @ApiOperation({ summary: 'Reconciliation runs', description: 'Newest first (keyset on start time, id).' })
  @ApiOkResponse({ type: RunPageDocument })
  @ApiErrors(ErrorCode.INVALID_CURSOR)
  runs(@Query() query: ListRunsQuery): Promise<AdminPage<RunView>> {
    return this.reads.runs(query.kind ?? null, query.cursor, pageSizeOf(query.limit));
  }

  @Get('reconciliation-runs/:runId')
  @ApiOperation({ summary: 'A reconciliation run', description: 'With its findings.' })
  @ApiParam({ name: 'runId', format: 'uuid' })
  @ApiOkResponse({ type: RunDetailDocument })
  @ApiErrors(ErrorCode.RECONCILIATION_RUN_NOT_FOUND)
  runDetail(@Param('runId', new ParseUUIDPipe()) runId: string): Promise<RunDetailView> {
    return this.reads.runDetail(runId);
  }

  @Get('users/:userId')
  @ApiOperation({ summary: 'A user', description: 'Ids and codes only — never an email.' })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiOkResponse({ type: AdminUserDocument })
  @ApiErrors(ErrorCode.USER_NOT_FOUND)
  user(@Param('userId', new ParseUUIDPipe()) userId: string): Promise<AdminUserView> {
    return this.reads.user(userId);
  }

  /** A user's history with every leg (internal accounts included) and the internal fields. */
  @Get('users/:userId/transactions')
  @ApiOperation({
    summary: 'A user\'s history (admin view)',
    description: 'The user\'s history with every leg (internal accounts included), metadata, external reference, the initiator\'s identity and the correction subject. Same query parameters as `GET /transactions`.',
  })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiOkResponse({ type: AdminTransactionPageDocument })
  @ApiErrors(ErrorCode.USER_NOT_FOUND, ErrorCode.INVALID_CURSOR, ErrorCode.UNSUPPORTED_CURRENCY)
  async userTransactions(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Query() query: ListTransactionsQuery,
  ): Promise<{ items: readonly AdminTransactionView[]; nextCursor: string | null }> {
    await this.reads.user(userId);
    return this.history.listForAdmin(userId, query);
  }

  @Get('users/:userId/transactions/:reference')
  @ApiOperation({ summary: 'One of a user\'s transactions (admin view)' })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiTransactionReference()
  @ApiOkResponse({ type: AdminTransactionDocument })
  @ApiErrors(ErrorCode.USER_NOT_FOUND, ErrorCode.TRANSACTION_NOT_FOUND)
  async userTransaction(@Param('userId', new ParseUUIDPipe()) userId: string, @Param('reference') reference: string): Promise<AdminTransactionView> {
    await this.reads.user(userId);
    return this.history.findForAdmin(userId, reference);
  }

  @Get('recertification')
  @Roles(UserRole.SECURITY)
  @ApiOperation({ summary: 'Role recertification', description: 'Every ADMIN / SECURITY holder with its grant record and last session, and any discrepancy between `users.role` and the assignment records (must be empty).' })
  @ApiOkResponse({ type: RecertificationDocument })
  recertification(): Promise<RecertificationReport> {
    return this.reads.recertification();
  }
}
