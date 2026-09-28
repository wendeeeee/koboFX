import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators';
import { NotFoundError } from '../../common/errors';
import { AuthenticatedUser } from '../../common/guards/authenticated-request';
import { UserRepository } from './user.repository';

export interface UserProfileResponse {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly role: string;
  readonly verifiedAt: string | null;
  readonly createdAt: string;
}

@Controller('users')
export class UsersController {
  constructor(private readonly users: UserRepository) {}

  /** The caller's own profile. Verified users only (the global default). */
  @Get('me')
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
