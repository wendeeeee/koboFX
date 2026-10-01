import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { ApiInstant, ApiUuid } from '../../openapi/properties';
import { UserRole, UserStatus } from '../users/user.types';
import { IssuedTokenResponse, SafeUser, SessionResponse, TokenPairResponse } from './auth.types';

/**
 * OpenAPI documentation of the auth bodies (Phase 11). Never instantiated: `implements` keeps each class in step
 * with the interface the code returns, and the response-reality tests catch a documented field that is not sent.
 */
@ApiSchema({ name: 'IssuedToken' })
export class IssuedTokenResponseDocument implements IssuedTokenResponse {
  @ApiProperty({ example: '<token>', description: 'Opaque to the client. Access: an RS256 JWT. Refresh: 256 random bits.' })
  token!: string;

  @ApiInstant('When the token stops being accepted.', '2026-09-29T10:15:00.000Z')
  expiresAt!: string;
}

@ApiSchema({ name: 'TokenPair' })
export class TokenPairResponseDocument implements TokenPairResponse {
  @ApiProperty({ enum: ['Bearer'], example: 'Bearer' })
  tokenType!: 'Bearer';

  @ApiProperty({ type: IssuedTokenResponseDocument, description: 'Send as `Authorization: Bearer <token>`.' })
  access!: IssuedTokenResponseDocument;

  @ApiProperty({ type: IssuedTokenResponseDocument, description: 'Exchange at `/auth/refresh` (single use; rotates).' })
  refresh!: IssuedTokenResponseDocument;
}

@ApiSchema({ name: 'SessionUser' })
export class SafeUserDocument implements SafeUser {
  @ApiUuid('The user id.', '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d')
  id!: string;

  @ApiProperty({ format: 'email', example: 'ada.lovelace@example.com' })
  email!: string;

  @ApiProperty({ enum: UserStatus, enumName: 'UserStatus', example: UserStatus.ACTIVE })
  status!: string;

  @ApiProperty({ enum: UserRole, enumName: 'UserRole', example: UserRole.USER })
  role!: string;

  @ApiInstant('When the email was verified; null while pending.', '2026-09-29T10:00:00.000Z', { nullable: true })
  verifiedAt!: string | null;
}

@ApiSchema({ name: 'Session' })
export class SessionResponseDocument implements SessionResponse {
  @ApiProperty({ type: SafeUserDocument })
  user!: SafeUserDocument;

  @ApiProperty({ type: TokenPairResponseDocument })
  tokens!: TokenPairResponseDocument;
}

@ApiSchema({ name: 'RefreshedTokens' })
export class RefreshResponseDocument implements Pick<SessionResponse, 'tokens'> {
  @ApiProperty({ type: TokenPairResponseDocument })
  tokens!: TokenPairResponseDocument;
}

/** The uniform acknowledgement of register and resend-otp (enumeration resistance: identical whatever the email's state). */
@ApiSchema({ name: 'UniformMessage' })
export class UniformMessageDocument {
  @ApiProperty({ example: 'If this email can be registered, a verification code has been sent to it.' })
  message!: string;
}
