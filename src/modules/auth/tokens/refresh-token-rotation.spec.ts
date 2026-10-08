import fc from 'fast-check';
import {
  RefreshTokenRevocationReason,
  decideRotation,
  generateRefreshToken,
  hashRefreshToken,
  isRefreshTokenLive,
  isWellFormedRefreshToken,
} from './refresh-token-rotation';

describe('refresh token rotation rule (design §9.1, decision #7: strict)', () => {
  const live = { familyRevoked: false, tokenUsed: false, tokenExpired: false, userActive: true };

  it('rotates a live token of an active user', () => {
    expect(decideRotation(live)).toEqual({ kind: 'ROTATE' });
  });

  it('a replayed (used) token revokes the whole family — even if it has expired since', () => {
    const reuse = { kind: 'REVOKE_FAMILY', reason: RefreshTokenRevocationReason.REUSE_DETECTED };
    expect(decideRotation({ ...live, tokenUsed: true })).toEqual(reuse);
    expect(decideRotation({ ...live, tokenUsed: true, tokenExpired: true })).toEqual(reuse);
    expect(decideRotation({ ...live, tokenUsed: true, userActive: false })).toEqual(reuse);
  });

  it('a revoked family refuses everything, and is not revoked again', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (tokenUsed, tokenExpired, userActive) => {
        expect(decideRotation({ familyRevoked: true, tokenUsed, tokenExpired, userActive })).toEqual({ kind: 'REJECT' });
      }),
    );
  });

  it('an expired, unused token is refused without revoking the family', () => {
    expect(decideRotation({ ...live, tokenExpired: true })).toEqual({ kind: 'REJECT' });
  });

  it('a user who is no longer ACTIVE loses the session', () => {
    expect(decideRotation({ ...live, userActive: false })).toEqual({
      kind: 'REVOKE_FAMILY',
      reason: RefreshTokenRevocationReason.USER_NOT_ACTIVE,
    });
  });

  it('only ROTATE ever issues a token, and only for a live token', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), (familyRevoked, tokenUsed, tokenExpired, userActive) => {
        const state = { familyRevoked, tokenUsed, tokenExpired, userActive };
        if (decideRotation(state).kind === 'ROTATE') expect(isRefreshTokenLive(state) && userActive).toBe(true);
        else expect(isRefreshTokenLive(state) && userActive).toBe(false);
      }),
    );
  });

  it('tokens are 256-bit, url-safe, unique, and hashed with SHA-256', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateRefreshToken));
    expect(tokens.size).toBe(1000);
    for (const token of tokens) {
      expect(isWellFormedRefreshToken(token)).toBe(true);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    }
    const [token] = tokens;
    expect(hashRefreshToken(token)).toHaveLength(32);
    expect(hashRefreshToken(token)).toEqual(hashRefreshToken(token));
    expect(isWellFormedRefreshToken(`${token}=`)).toBe(false);
    expect(isWellFormedRefreshToken('a.b.c')).toBe(false);
  });
});
