import { ApiSchema, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsIn, IsObject, IsOptional, IsString, Length, Matches } from 'class-validator';
import { ApprovalActionType, ApprovalStatus } from '../approval.types';

/**
 * `POST /admin/approvals` — request a sensitive action (design §12). The payload's shape depends on the action
 * type and is validated (strictly) by `parseActionPayload`; `reason` is the audit trail's *why*. `breakGlass`
 * asks for the single-actor path — refused for every action outside its subset.
 */
@ApiSchema({ name: 'ApprovalRequest' })
export class RequestApprovalDto {
  @ApiProperty({ enum: ApprovalActionType, enumName: 'ApprovalActionType' })
  @IsEnum(ApprovalActionType)
  actionType!: ApprovalActionType;

  @ApiProperty({ type: 'object', additionalProperties: true, description: 'Shape depends on `actionType` (strictly validated).' })
  @IsObject()
  payload!: Record<string, unknown>;

  @ApiProperty({ minLength: 1, maxLength: 500, description: 'Why: kept on the audit trail.' })
  @IsString()
  @Length(1, 500)
  reason!: string;

  @ApiPropertyOptional({ description: 'The single-actor emergency path (SUSPEND_USER, RATE_OVERRIDE MANUAL_RATE only).' })
  @IsOptional()
  @IsBoolean()
  breakGlass?: boolean;
}

@ApiSchema({ name: 'RejectApprovalRequest' })
export class RejectApprovalDto {
  @ApiProperty({ minLength: 1, maxLength: 500, example: 'Amount does not match the ticket.', description: 'Why it is rejected (audit trail).' })
  @IsString()
  @Length(1, 500)
  reason!: string;
}

@ApiSchema({ name: 'ReviewBreakGlassRequest' })
export class ReviewBreakGlassDto {
  @ApiProperty({ minLength: 1, maxLength: 500, example: 'Justified: provider outage confirmed.', description: 'The review\'s conclusion (audit trail).' })
  @IsString()
  @Length(1, 500)
  note!: string;
}

export class ListApprovalsQuery {
  @ApiPropertyOptional({ enum: ApprovalStatus, enumName: 'ApprovalStatus' })
  @IsOptional()
  @IsEnum(ApprovalStatus)
  status?: ApprovalStatus;

  @ApiPropertyOptional({ enum: ApprovalActionType, enumName: 'ApprovalActionType' })
  @IsOptional()
  @IsEnum(ApprovalActionType)
  actionType?: ApprovalActionType;

  /** `unreviewed`: break-glass uses awaiting a security review (the security queue). */
  @ApiPropertyOptional({ enum: ['unreviewed'], description: '`unreviewed`: break-glass uses awaiting a SECURITY review (the security queue).' })
  @IsOptional()
  @IsIn(['unreviewed'])
  breakGlass?: 'unreviewed';

  @ApiPropertyOptional({ minLength: 1, maxLength: 256, description: 'The previous page\'s `nextCursor` (same filters).' })
  @IsOptional()
  @IsString()
  @Length(1, 256)
  cursor?: string;

  @ApiPropertyOptional({ type: 'string', pattern: '^\\d{1,3}$', example: '50', description: 'Page size, 1–100 (default 50).' })
  @IsOptional()
  @Matches(/^\d{1,3}$/)
  limit?: string;
}
