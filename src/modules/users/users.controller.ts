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
  /** A transaction PIN exists (required to withdraw and convert): the dashboard offers to create one until it does. */
  readonly transactionPinSet: boolean;
  /** Locked after too many wrong PINs: only a reset unlocks it. */
  readonly transactionPinLocked: boolean;
}

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UserRepository) {}

  @Get('me')
  @ApiOperation({ summary: 'My profile' })
  @ApiOkResponse({ type: UserProfileDocument })
  @ApiErrors(ErrorCode.NOT_FOUND)
  async me(@CurrentUser() user: AuthenticatedUser): Promise<UserProfileResponse> {
    const profile = await this.users.findProfile(user.id);
    if (!profile) throw new NotFoundError('User not found.');
    const pin = await this.users.findTransactionPinState(user.id);
    return {
      id: profile.id,
      email: profile.email,
      status: profile.status,
      role: profile.role,
      verifiedAt: profile.verifiedAt?.toISOString() ?? null,
      createdAt: profile.createdAt.toISOString(),
      transactionPinSet: pin.set,
      transactionPinLocked: pin.locked,
    };
  }
}
