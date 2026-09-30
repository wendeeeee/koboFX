import { IsBoolean, IsEnum, IsIn, IsObject, IsOptional, IsString, Length, Matches } from 'class-validator';
import { ApprovalActionType, ApprovalStatus } from '../approval.types';

/**
 * `POST /admin/approvals` — request a sensitive action (design §12). The payload's shape depends on the action
 * type and is validated (strictly) by `parseActionPayload`; `reason` is the audit trail's *why*. `breakGlass`
 * asks for the single-actor path — refused for every action outside its subset.
 */
export class RequestApprovalDto {
  @IsEnum(ApprovalActionType)
  actionType!: ApprovalActionType;

  @IsObject()
  payload!: Record<string, unknown>;

  @IsString()
  @Length(1, 500)
  reason!: string;

  @IsOptional()
  @IsBoolean()
  breakGlass?: boolean;
}

export class RejectApprovalDto {
  @IsString()
  @Length(1, 500)
  reason!: string;
}

export class ReviewBreakGlassDto {
  @IsString()
  @Length(1, 500)
  note!: string;
}

export class ListApprovalsQuery {
  @IsOptional()
  @IsEnum(ApprovalStatus)
  status?: ApprovalStatus;

  @IsOptional()
  @IsEnum(ApprovalActionType)
  actionType?: ApprovalActionType;

  /** `unreviewed`: break-glass uses awaiting a security review (the security queue). */
  @IsOptional()
  @IsIn(['unreviewed'])
  breakGlass?: 'unreviewed';

  @IsOptional()
  @IsString()
  @Length(1, 256)
  cursor?: string;

  @IsOptional()
  @Matches(/^\d{1,3}$/)
  limit?: string;
}
