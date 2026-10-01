import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Idempotent, RateLimit, Roles } from '../../../common/decorators';
import { ErrorCode } from '../../../common/errors';
import { ApiErrors } from '../../../openapi/api-errors.decorator';
import { APPROVAL_REQUEST_EXAMPLES, approvalRequestSchemaName } from '../actions/action-payload.schemas';
import { RateLimitRule } from '../../../common/decorators/rate-limit.decorator';
import { AuthenticatedUser } from '../../../common/guards/authenticated-request';
import { UserRole } from '../../users/user.types';
import { AdminPage, decodeAdminCursor, filterFingerprint, pageSizeOf, toPage } from '../reads/admin-cursor';
import { AuditTrailEntry, AuditTrailReader } from '../reads/audit-trail.reader';
import { ApprovalRepository } from './approval.repository';
import { ApprovalService } from './approval.service';
import { ApprovalActionType } from './approval.types';
import { ApprovalDetailDocument, ApprovalDocument, ApprovalPageDocument } from './approval.responses';
import { ApprovalView, toApprovalView } from './approval.view';
import { ListApprovalsQuery, RejectApprovalDto, RequestApprovalDto, ReviewBreakGlassDto } from './dto/approval.dto';

/** Per administrator, on top of the global per-IP limit (Phase 10 plan §E.11). */
export const ADMIN_WRITE_RATE_LIMIT_RULE: RateLimitRule = { name: 'admin-writes', subject: 'user', limit: 30, windowSeconds: 60 };
export const ADMIN_READ_RATE_LIMIT_RULE: RateLimitRule = { name: 'admin-reads', subject: 'user', limit: 120, windowSeconds: 60 };

const WRITES = { rules: [ADMIN_WRITE_RATE_LIMIT_RULE], whenUnavailable: 'fail-open' } as const;
const READS = { rules: [ADMIN_READ_RATE_LIMIT_RULE], whenUnavailable: 'fail-open' } as const;

const ApiApprovalId = (): MethodDecorator => ApiParam({ name: 'approvalId', format: 'uuid' });

/** The decision routes' shared refusals (who may decide, and in which state). */
const DECISION_ERRORS = [ErrorCode.APPROVAL_NOT_FOUND, ErrorCode.APPROVAL_ALREADY_DECIDED] as const;

/** One whole-body variant per action (OpenAPI cannot discriminate `payload` by the sibling `actionType`). */
const REQUEST_BODY_SCHEMA = {
  oneOf: Object.values(ApprovalActionType).map((actionType) => ({ $ref: `#/components/schemas/${approvalRequestSchemaName(actionType)}` })),
  discriminator: {
    propertyName: 'actionType',
    mapping: Object.fromEntries(
      Object.values(ApprovalActionType).map((actionType) => [actionType, `#/components/schemas/${approvalRequestSchemaName(actionType)}`]),
    ),
  },
};

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
@ApiTags('admin-approvals')
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
  @ApiOperation({
    summary: 'Request a sensitive action',
    description:
      'Four-eyes (design §9.2): the request waits for a DIFFERENT eligible person to approve it (ADMIN, or SECURITY for ' +
      'ROLE_CHANGE), within the time to live (72h by default). The payload is validated strictly per `actionType` and ' +
      'against the world now (`409 ACTION_PRECONDITION_FAILED` / `PERIOD_LOCKED`). `breakGlass: true` (SUSPEND_USER, ' +
      'RATE_OVERRIDE MANUAL_RATE only) executes it in this request: the `201` body is then EXECUTED or EXECUTION_FAILED, ' +
      'and security is paged.',
  })
  @ApiBody({ schema: REQUEST_BODY_SCHEMA, examples: APPROVAL_REQUEST_EXAMPLES })
  @ApiCreatedResponse({ type: ApprovalDocument })
  @ApiErrors(ErrorCode.BREAK_GLASS_NOT_ALLOWED, ErrorCode.ACTION_PRECONDITION_FAILED, ErrorCode.PERIOD_LOCKED)
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
  @ApiOperation({ summary: 'Approvals', description: 'Newest first. `breakGlass=unreviewed` is the security review queue.' })
  @ApiOkResponse({ type: ApprovalPageDocument })
  @ApiErrors(ErrorCode.INVALID_CURSOR)
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
  @ApiOperation({ summary: 'An approval', description: 'With its audit trail: request → decision → execution → what it did.' })
  @ApiApprovalId()
  @ApiOkResponse({ type: ApprovalDetailDocument })
  @ApiErrors(ErrorCode.APPROVAL_NOT_FOUND)
  async find(@Param('approvalId', new ParseUUIDPipe()) approvalId: string): Promise<ApprovalDetailView> {
    const approval = await this.approvals.find(approvalId);
    return { ...toApprovalView(approval), trail: await this.trail.forApproval(approval) };
  }

  @Post(':approvalId/approve')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITES)
  @Idempotent()
  @ApiOperation({
    summary: 'Approve (and execute)',
    description:
      'By a different person holding the action\'s decider role (ADMIN; SECURITY for ROLE_CHANGE). Executes at once, in ' +
      'this request. If the world moved since the request, execution is refused and recorded: the answer is still ' +
      '**200** with `status: EXECUTION_FAILED` and `executionFailureCode` — not an error status.',
  })
  @ApiApprovalId()
  @ApiOkResponse({ type: ApprovalDocument, description: 'EXECUTED, or EXECUTION_FAILED with `executionFailureCode`.' })
  @ApiErrors(...DECISION_ERRORS, ErrorCode.SELF_APPROVAL_FORBIDDEN, ErrorCode.APPROVAL_EXPIRED, ErrorCode.APPROVAL_REQUESTER_INELIGIBLE)
  async approve(@CurrentUser() user: AuthenticatedUser, @Param('approvalId', new ParseUUIDPipe()) approvalId: string): Promise<ApprovalView> {
    return toApprovalView(await this.approvals.approve(approvalId, user.id));
  }

  @Post(':approvalId/reject')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITES)
  @Idempotent()
  @ApiOperation({ summary: 'Reject', description: 'By a different person holding the action\'s decider role, while PENDING and not expired.' })
  @ApiApprovalId()
  @ApiOkResponse({ type: ApprovalDocument, description: 'REJECTED.' })
  @ApiErrors(...DECISION_ERRORS, ErrorCode.SELF_APPROVAL_FORBIDDEN, ErrorCode.APPROVAL_EXPIRED, ErrorCode.APPROVAL_REQUESTER_INELIGIBLE)
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
  @ApiOperation({ summary: 'Cancel my request', description: 'The requester only, while PENDING.' })
  @ApiApprovalId()
  @ApiOkResponse({ type: ApprovalDocument, description: 'CANCELLED.' })
  @ApiErrors(...DECISION_ERRORS)
  async cancel(@CurrentUser() user: AuthenticatedUser, @Param('approvalId', new ParseUUIDPipe()) approvalId: string): Promise<ApprovalView> {
    return toApprovalView(await this.approvals.cancel(approvalId, user.id));
  }

  @Post(':approvalId/review')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.SECURITY)
  @RateLimit(WRITES)
  @Idempotent()
  @ApiOperation({
    summary: 'Review a break-glass use',
    description: 'SECURITY, never the actor, once per break-glass use (unreviewed after 24h pages again).',
  })
  @ApiApprovalId()
  @ApiOkResponse({ type: ApprovalDocument, description: 'With `review` set.' })
  @ApiErrors(ErrorCode.APPROVAL_NOT_FOUND, ErrorCode.BREAK_GLASS_ALREADY_REVIEWED, ErrorCode.SELF_APPROVAL_FORBIDDEN)
  async review(
    @CurrentUser() user: AuthenticatedUser,
    @Param('approvalId', new ParseUUIDPipe()) approvalId: string,
    @Body() body: ReviewBreakGlassDto,
  ): Promise<ApprovalView> {
    return toApprovalView(await this.approvals.review(approvalId, user.id, body.note));
  }
}
