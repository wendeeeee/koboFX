import { UserProfile } from '../users/user.repository';

export interface IssuedTokenResponse {
  readonly token: string;
  readonly expiresAt: string;
}

export interface TokenPairResponse {
  readonly tokenType: 'Bearer';
  readonly access: IssuedTokenResponse;
  readonly refresh: IssuedTokenResponse;
}

export interface SafeUser {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly role: string;
  readonly verifiedAt: string | null;
}

export interface SessionResponse {
  readonly user: SafeUser;
  readonly tokens: TokenPairResponse;
}

export function toSafeUser(profile: UserProfile): SafeUser {
  return {
    id: profile.id,
    email: profile.email,
    status: profile.status,
    role: profile.role,
    verifiedAt: profile.verifiedAt?.toISOString() ?? null,
  };
}

export const REGISTRATION_ACCEPTED = {
  message: 'If this email can be registered, a verification code has been sent to it.',
} as const;
export const VERIFICATION_CODE_REQUESTED = {
  message: 'If this email is awaiting verification, a new code has been sent to it.',
} as const;
