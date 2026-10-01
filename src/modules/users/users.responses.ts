import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { ApiInstant, ApiUuid } from '../../openapi/properties';
import type { UserProfileResponse } from './users.controller';
import { UserRole, UserStatus } from './user.types';

/** OpenAPI documentation of `GET /users/me` (Phase 11). Never instantiated. */
@ApiSchema({ name: 'UserProfile' })
export class UserProfileDocument implements UserProfileResponse {
  @ApiUuid('The user id.', '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d')
  id!: string;

  @ApiProperty({ format: 'email', example: 'ada.lovelace@example.com' })
  email!: string;

  @ApiProperty({ enum: UserStatus, enumName: 'UserStatus', example: UserStatus.ACTIVE })
  status!: string;

  @ApiProperty({ enum: UserRole, enumName: 'UserRole', example: UserRole.USER })
  role!: string;

  @ApiInstant('When the email was verified.', '2026-09-29T10:00:00.000Z', { nullable: true })
  verifiedAt!: string | null;

  @ApiInstant('When the account was created.', '2026-09-29T09:58:12.000Z')
  createdAt!: string;
}
