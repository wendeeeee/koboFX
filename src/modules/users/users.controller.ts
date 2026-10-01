import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators';
import { ErrorCode, NotFoundError } from '../../common/errors';
import { ApiErrors } from '../../openapi/api-errors.decorator';
import { AuthenticatedUser } from '../../common/guards/authenticated-request';
import { UserRepository } from './user.repository';
import { UserProfileDocument } from './users.responses';

export interface UserProfileResponse {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly role: string;
  readonly verifiedAt: string | null;
  readonly createdAt: string;
}

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UserRepository) {}

  /** The caller's own profile. Verified users only (the global default). */
  @Get('me')
  @ApiOperation({ summary: 'My profile' })
  @ApiOkResponse({ type: UserProfileDocument })
  @ApiErrors(ErrorCode.NOT_FOUND)
  async me(@CurrentUser() user: AuthenticatedUser): Promise<UserProfileResponse> {
    const profile = await this.users.findProfile(user.id);
    if (!profile) throw new NotFoundError('User not found.');
    return {
      id: profile.id,
      email: profile.email,
      status: profile.status,
      role: profile.role,
      verifiedAt: profile.verifiedAt?.toISOString() ?? null,
      createdAt: profile.createdAt.toISOString(),
    };
  }
}
