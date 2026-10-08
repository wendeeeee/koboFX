import { createHash, randomBytes } from 'node:crypto';

export enum RefreshTokenRevocationReason {
  LOGOUT = 'LOGOUT',
  REUSE_DETECTED = 'REUSE_DETECTED',
  USER_NOT_ACTIVE = 'USER_NOT_ACTIVE',
}

export interface RefreshTokenState {
  readonly familyRevoked: boolean;
  readonly tokenUsed: boolean;
  readonly tokenExpired: boolean;
  readonly userActive: boolean;
}

export type RotationDecision =
  | { readonly kind: 'ROTATE' }
  | { readonly kind: 'REJECT' }
  | { readonly kind: 'REVOKE_FAMILY'; readonly reason: RefreshTokenRevocationReason };


export function decideRotation(state: RefreshTokenState): RotationDecision {
  if (state.familyRevoked) return { kind: 'REJECT' };
  if (state.tokenUsed) return { kind: 'REVOKE_FAMILY', reason: RefreshTokenRevocationReason.REUSE_DETECTED };
  if (state.tokenExpired) return { kind: 'REJECT' };
  if (!state.userActive) return { kind: 'REVOKE_FAMILY', reason: RefreshTokenRevocationReason.USER_NOT_ACTIVE };
  return { kind: 'ROTATE' };
}

export function isRefreshTokenLive(state: Omit<RefreshTokenState, 'userActive'>): boolean {
  return !state.familyRevoked && !state.tokenUsed && !state.tokenExpired;
}

const REFRESH_TOKEN_BYTES = 32;
const REFRESH_TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

export function isWellFormedRefreshToken(token: string): boolean {
  return REFRESH_TOKEN_FORMAT.test(token);
}


export function hashRefreshToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
