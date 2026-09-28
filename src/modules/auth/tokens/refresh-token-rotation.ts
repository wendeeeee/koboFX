import { createHash, randomBytes } from 'node:crypto';

/** `refresh_token_revocation_reason`. */
export enum RefreshTokenRevocationReason {
  LOGOUT = 'LOGOUT',
  /** A used (already rotated) token was presented again: assume theft, kill the session. */
  REUSE_DETECTED = 'REUSE_DETECTED',
  /** The user was suspended (or is otherwise not ACTIVE) when the session tried to refresh. */
  USER_NOT_ACTIVE = 'USER_NOT_ACTIVE',
}

/** What the database says about a presented refresh token, read under the family lock. */
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

/**
 * The rotation rule (design §9.1, decision #7 — strict, no grace window):
 *
 * 1. A revoked family refuses everything.
 * 2. A token that was already used is a replay — even if it has since expired, and
 *    even if it is "just" a second browser tab: the whole family is revoked.
 * 3. An expired token is refused (the family stays as it is).
 * 4. A user who is no longer ACTIVE loses the session.
 * 5. Otherwise: rotate — this token becomes used, and exactly one child is issued.
 */
export function decideRotation(state: RefreshTokenState): RotationDecision {
  if (state.familyRevoked) return { kind: 'REJECT' };
  if (state.tokenUsed) return { kind: 'REVOKE_FAMILY', reason: RefreshTokenRevocationReason.REUSE_DETECTED };
  if (state.tokenExpired) return { kind: 'REJECT' };
  if (!state.userActive) return { kind: 'REVOKE_FAMILY', reason: RefreshTokenRevocationReason.USER_NOT_ACTIVE };
  return { kind: 'ROTATE' };
}

/** A token is live iff unused, unexpired, and its family is not revoked. */
export function isRefreshTokenLive(state: Omit<RefreshTokenState, 'userActive'>): boolean {
  return !state.familyRevoked && !state.tokenUsed && !state.tokenExpired;
}

const REFRESH_TOKEN_BYTES = 32;
/** 32 random bytes in base64url: exactly 43 characters. */
const REFRESH_TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

/** An opaque 256-bit random refresh token. Only its hash is ever stored. */
export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

export function isWellFormedRefreshToken(token: string): boolean {
  return REFRESH_TOKEN_FORMAT.test(token);
}

/**
 * SHA-256, not a slow password hash: the token has 256 bits of entropy, so there is
 * nothing to brute-force, and a deterministic hash is what makes lookup by hash work.
 */
export function hashRefreshToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
