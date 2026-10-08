import { randomUUID } from 'node:crypto';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccountSuspendedError, EmailNotVerifiedError } from '../../modules/auth/auth.errors';
import { AccessTokenService } from '../../modules/auth/tokens/access-token.service';
import { AuthenticationState, UserRepository } from '../../modules/users/user.repository';
import { UserRole, UserStatus } from '../../modules/users/user.types';
import { ALLOW_UNVERIFIED_KEY } from '../decorators/allow-unverified.decorator';
import { currentUserFrom } from '../decorators/current-user.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { ForbiddenError, InvariantViolationError, UnauthenticatedError } from '../errors';
import { AuthenticatedRequest, AuthenticatedUser } from './authenticated-request';
import { JwtAuthGuard, bearerToken } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { VerifiedUserGuard } from './verified-user.guard';

type Metadata = Partial<Record<typeof IS_PUBLIC_KEY | typeof ALLOW_UNVERIFIED_KEY | typeof ROLES_KEY, unknown>>;

function contextFor(request: Partial<AuthenticatedRequest>, metadata: Metadata = {}): {
  context: ExecutionContext;
  reflector: Reflector;
} {
  const handler = () => undefined;
  class Controller {}
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => metadata[key as keyof Metadata]);
  const context = {
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, reflector };
}

const userId = randomUUID();
const familyId = randomUUID();
const user = (status: UserStatus, role = UserRole.USER): AuthenticatedUser => ({
  id: userId,
  role,
  status,
  refreshTokenFamilyId: familyId,
});

describe('guard decisions', () => {
  describe('JwtAuthGuard (deny by default)', () => {
    const accessTokens = { verify: jest.fn() } as unknown as jest.Mocked<AccessTokenService>;
    const users = { findAuthenticationState: jest.fn() } as unknown as jest.Mocked<UserRepository>;
    const state = (overrides: Partial<AuthenticationState> = {}): AuthenticationState => ({
      userId,
      status: UserStatus.ACTIVE,
      role: UserRole.USER,
      sessionRevoked: false,
      ...overrides,
    });
    beforeEach(() => {
      jest.resetAllMocks();
      accessTokens.verify.mockReturnValue({ userId, refreshTokenFamilyId: familyId, expiresAt: new Date() });
    });

    it('lets a @Public() route through without a token, and sets no user', async () => {
      const request: Partial<AuthenticatedRequest> = { headers: {} };
      const { context, reflector } = contextFor(request, { [IS_PUBLIC_KEY]: true });
      await expect(new JwtAuthGuard(reflector, accessTokens, users).canActivate(context)).resolves.toBe(true);
      expect(request.user).toBeUndefined();
      expect(accessTokens.verify).not.toHaveBeenCalled();
    });

    it('refuses a protected route without a Bearer token', async () => {
      for (const authorization of [undefined, '', 'Basic abc', 'Bearer', 'Bearer not-a-jwt', 'bearer a.b.c']) {
        const { context, reflector } = contextFor({ headers: { authorization } });
        await expect(new JwtAuthGuard(reflector, accessTokens, users).canActivate(context)).rejects.toThrow(
          UnauthenticatedError,
        );
      }
    });

    it('propagates an invalid token as 401', async () => {
      accessTokens.verify.mockImplementation(() => {
        throw new UnauthenticatedError('bad');
      });
      const { context, reflector } = contextFor({ headers: { authorization: 'Bearer a.b.c' } });
      await expect(new JwtAuthGuard(reflector, accessTokens, users).canActivate(context)).rejects.toThrow(
        UnauthenticatedError,
      );
    });

    it('re-reads the user: a revoked session or an unknown user is 401 even with a valid signature', async () => {
      for (const found of [null, state({ sessionRevoked: true })]) {
        users.findAuthenticationState.mockResolvedValue(found);
        const { context, reflector } = contextFor({ headers: { authorization: 'Bearer a.b.c' } });
        await expect(new JwtAuthGuard(reflector, accessTokens, users).canActivate(context)).rejects.toThrow(
          UnauthenticatedError,
        );
      }
    });

    it('attaches a frozen user whose role and status come from the database, not the token', async () => {
      users.findAuthenticationState.mockResolvedValue(state({ role: UserRole.ADMIN, status: UserStatus.SUSPENDED }));
      const request: Partial<AuthenticatedRequest> = { headers: { authorization: 'Bearer a.b.c' } };
      const { context, reflector } = contextFor(request);
      await expect(new JwtAuthGuard(reflector, accessTokens, users).canActivate(context)).resolves.toBe(true);
      expect(users.findAuthenticationState).toHaveBeenCalledWith(userId, familyId);
      expect(request.user).toEqual(user(UserStatus.SUSPENDED, UserRole.ADMIN));
      expect(Object.isFrozen(request.user)).toBe(true);
    });

    it('extracts only a well-formed Bearer JWT', () => {
      expect(bearerToken('Bearer aaa.bbb.ccc')).toBe('aaa.bbb.ccc');
      expect(bearerToken('Bearer aaa.bbb.ccc extra')).toBeUndefined();
      expect(bearerToken(undefined)).toBeUndefined();
    });
  });

  describe('RolesGuard', () => {
    it('allows any authenticated user when the route declares no roles', () => {
      const { context, reflector } = contextFor({ user: user(UserStatus.ACTIVE) });
      expect(new RolesGuard(reflector).canActivate(context)).toBe(true);
    });

    it('allows a holder of a listed role and forbids everyone else', () => {
      const admin = contextFor({ user: user(UserStatus.ACTIVE, UserRole.ADMIN) }, { [ROLES_KEY]: [UserRole.ADMIN] });
      expect(new RolesGuard(admin.reflector).canActivate(admin.context)).toBe(true);
      const plain = contextFor({ user: user(UserStatus.ACTIVE) }, { [ROLES_KEY]: [UserRole.ADMIN] });
      expect(() => new RolesGuard(plain.reflector).canActivate(plain.context)).toThrow(ForbiddenError);
    });

    it('refuses a role-restricted route with no authenticated user', () => {
      const { context, reflector } = contextFor({}, { [ROLES_KEY]: [UserRole.ADMIN] });
      expect(() => new RolesGuard(reflector).canActivate(context)).toThrow(UnauthenticatedError);
    });
  });

  describe('VerifiedUserGuard', () => {
    it('allows ACTIVE users', () => {
      const { context, reflector } = contextFor({ user: user(UserStatus.ACTIVE) });
      expect(new VerifiedUserGuard(reflector).canActivate(context)).toBe(true);
    });

    it('refuses SUSPENDED with ACCOUNT_SUSPENDED and PENDING with EMAIL_NOT_VERIFIED', () => {
      const suspended = contextFor({ user: user(UserStatus.SUSPENDED) });
      expect(() => new VerifiedUserGuard(suspended.reflector).canActivate(suspended.context)).toThrow(AccountSuspendedError);
      const pending = contextFor({ user: user(UserStatus.PENDING_VERIFICATION) });
      expect(() => new VerifiedUserGuard(pending.reflector).canActivate(pending.context)).toThrow(EmailNotVerifiedError);
    });

    it('lets @AllowUnverified() and @Public() routes through for anyone', () => {
      const unverified = contextFor({ user: user(UserStatus.SUSPENDED) }, { [ALLOW_UNVERIFIED_KEY]: true });
      expect(new VerifiedUserGuard(unverified.reflector).canActivate(unverified.context)).toBe(true);
      const publicRoute = contextFor({}, { [IS_PUBLIC_KEY]: true });
      expect(new VerifiedUserGuard(publicRoute.reflector).canActivate(publicRoute.context)).toBe(true);
    });

    it('refuses a protected route with no user at all (never allow by accident)', () => {
      const { context, reflector } = contextFor({});
      expect(() => new VerifiedUserGuard(reflector).canActivate(context)).toThrow(EmailNotVerifiedError);
    });
  });

  describe('@CurrentUser()', () => {
    it('returns the authenticated user, and fails loudly on a route that has none', () => {
      expect(currentUserFrom(contextFor({ user: user(UserStatus.ACTIVE) }).context)).toEqual(user(UserStatus.ACTIVE));
      expect(() => currentUserFrom(contextFor({}).context)).toThrow(InvariantViolationError);
    });
  });
});
