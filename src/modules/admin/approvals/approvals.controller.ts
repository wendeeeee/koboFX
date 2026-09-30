import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CurrentUser, Idempotent, RateLimit, Roles } from '../../../common/decorators';
import { RateLimitRule } from '../../../common/decorators/rate-limit.decorator';
import { AuthenticatedUser } from '../../../common/guards/authenticated-request';
import { UserRole } from '../../users/user.types';
import { AdminPage, decodeAdminCursor, filterFingerprint, pageSizeOf, toPage } from '../reads/admin-cursor';
import { AuditTrailEntry, AuditTrailReader } from '../reads/audit-trail.reader';
import { ApprovalRepository } from './approval.repository';
import { ApprovalService } from './approval.service';
import { ApprovalView, toApprovalView } from './approval.view';
import { ListApprovalsQuery, RejectApprovalDto, RequestApprovalDto, ReviewBreakGlassDto } from './dto/approval.dto';

/** Per administrator, on top of the global per-IP limit (Phase 10 plan §E.11). */
export const ADMIN_WRITE_RATE_LIMIT_RULE: RateLimitRule = { name: 'admin-writes', subject: 'user', limit: 30, windowSeconds: 60 };
export const ADMIN_READ_RATE_LIMIT_RULE: RateLimitRule = { name: 'admin-reads', subject: 'user', limit: 120, windowSeconds: 60 };

const WRITES = { rules: [ADMIN_WRITE_RATE_LIMIT_RULE], whenUnavailable: 'fail-open' } as const;
const READS = { rules: [ADMIN_READ_RATE_LIMIT_RULE], whenUnavailable: 'fail-open' } as const;

export interface ApprovalDetailView extends ApprovalView {
  /** Every audit row about this approval or naming it: request → decision → execution → what it did. */
  readonly trail: readonly AuditTrailEntry[];
}

/**
 * Four-eyes over HTTP (design §9.2, §12). Class-level `@Roles(ADMIN, SECURITY)` — deny by default — and each
 * route narrows it: an ADMIN requests; the decider role depends on the action (the service checks it, and the
 * database again). Every write is behind the idempotency barrier: a retried approve replays its outcome, it never
 * executes twice.
 */
@Controller('admin/approvals')
@Roles(UserRole.ADMIN, UserRole.SECURITY)
export class ApprovalsController {
  constructor(
    private readonly approvals: ApprovalService,
    private readonly repository: ApprovalRepository,
    private readonly trail: AuditTrailReader,
  ) {}

  @Post()
  @Roles(UserRole.ADMIN)
  @RateLimit(WRITES)
  @Idempotent()
  async request(@CurrentUser() user: AuthenticatedUser, @Body() body: RequestApprovalDto): Promise<ApprovalView> {
    return toApprovalView(
      await this.approvals.request(user.id, {
        actionType: body.actionType,
        payload: body.payload,
        reason: body.reason,
        breakGlass: body.breakGlass === true,
      }),
    );
  }

  @Get()
  @RateLimit(READS)
  async list(@Query() query: ListApprovalsQuery): Promise<AdminPage<ApprovalView>> {
    const limit = pageSizeOf(query.limit);
    const filter = { status: query.status ?? null, actionType: query.actionType ?? null, unreviewedBreakGlass: query.breakGlass === 'unreviewed' };
    const fingerprint = filterFingerprint('approvals', filter);
    const position = query.cursor ? decodeAdminCursor(query.cursor, fingerprint) : null;
    const rows = await this.repository.list(filter, position, limit + 1);
    return toPage(rows.map((row) => ({ item: toApprovalView(row.item), position: row.position })), limit, fingerprint);
  }

  @Get(':approvalId')
  @RateLimit(READS)
  async find(@Param('approvalId', new ParseUUIDPipe()) approvalId: string): Promise<ApprovalDetailView> {
    const approval = await this.approvals.find(approvalId);
    return { ...toApprovalView(approval), trail: await this.trail.forApproval(approval) };
  }

  @Post(':approvalId/approve')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITES)
  @Idempotent()
  async approve(@CurrentUser() user: AuthenticatedUser, @Param('approvalId', new ParseUUIDPipe()) approvalId: string): Promise<ApprovalView> {
    return toApprovalView(await this.approvals.approve(approvalId, user.id));
  }

  @Post(':approvalId/reject')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITES)
  @Idempotent()
  async reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('approvalId', new ParseUUIDPipe()) approvalId: string,
    @Body() body: RejectApprovalDto,
  ): Promise<ApprovalView> {
    return toApprovalView(await this.approvals.reject(approvalId, user.id, body.reason));
  }

  @Post(':approvalId/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN)
  @RateLimit(WRITES)
  @Idempotent()
  async cancel(@CurrentUser() user: AuthenticatedUser, @Param('approvalId', new ParseUUIDPipe()) approvalId: string): Promise<ApprovalView> {
    return toApprovalView(await this.approvals.cancel(approvalId, user.id));
  }

  @Post(':approvalId/review')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.SECURITY)
  @RateLimit(WRITES)
  @Idempotent()
  async review(
    @CurrentUser() user: AuthenticatedUser,
    @Param('approvalId', new ParseUUIDPipe()) approvalId: string,
    @Body() body: ReviewBreakGlassDto,
  ): Promise<ApprovalView> {
    return toApprovalView(await this.approvals.review(approvalId, user.id, body.note));
  }
}
