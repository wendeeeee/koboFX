import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Clock } from '../../../common/clock';
import { UnauthenticatedError } from '../../../common/errors';
import { APP_CONFIG } from '../../../config/config.module';
import { AccessTokenConfig, AppConfig } from '../../../config/configuration';

export const ACCESS_TOKEN_ALGORITHM = 'RS256';
const ACCESS_TOKEN_USE = 'access';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface AccessTokenClaims {
  readonly userId: string;
  readonly refreshTokenFamilyId: string;
  readonly expiresAt: Date;
}

interface AccessTokenPayload {
  sub?: unknown;
  familyId?: unknown;
  tokenUse?: unknown;
  exp?: unknown;
}

/**
 * Access tokens: JWT, RS256, 15 minutes.
 */
@Injectable()
export class AccessTokenService {
  private readonly config: AccessTokenConfig;
  private readonly publicKeyPems: ReadonlyMap<string, string>;

  constructor(
    private readonly jwt: JwtService,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) appConfig: AppConfig,
  ) {
    this.config = appConfig.authentication.accessToken;
    this.publicKeyPems = new Map(
      [...this.config.publicKeys].map(([keyId, key]) => [keyId, key.export({ type: 'spki', format: 'pem' }).toString()]),
    );
  }

  issue(userId: string, refreshTokenFamilyId: string): IssuedAccessToken {
    const issuedAtSeconds = Math.floor(this.clock.now().getTime() / 1000);
    const token = this.jwt.sign(
      { familyId: refreshTokenFamilyId, tokenUse: ACCESS_TOKEN_USE, iat: issuedAtSeconds },
      {
        algorithm: ACCESS_TOKEN_ALGORITHM,
        privateKey: this.config.privateKey,
        keyid: this.config.signingKeyId,
        subject: userId,
        issuer: this.config.issuer,
        audience: this.config.audience,
        expiresIn: this.config.timeToLiveSeconds,
        jwtid: randomUUID(),
      },
    );
    return { token, expiresAt: new Date((issuedAtSeconds + this.config.timeToLiveSeconds) * 1000) };
  }

  verify(token: string): AccessTokenClaims {
    const header = this.decodeHeader(token);
    const publicKey = typeof header?.kid === 'string' ? this.publicKeyPems.get(header.kid) : undefined;
    if (!header || header.alg !== ACCESS_TOKEN_ALGORITHM || !publicKey) throw invalidToken();

    let payload: AccessTokenPayload;
    try {
      payload = this.jwt.verify<AccessTokenPayload & object>(token, {
        publicKey,
        algorithms: [ACCESS_TOKEN_ALGORITHM],
        issuer: this.config.issuer,
        audience: this.config.audience,
        clockTimestamp: Math.floor(this.clock.now().getTime() / 1000),
      });
    } catch {
      throw invalidToken();
    }
    const { sub, familyId, tokenUse, exp } = payload;
    if (
      typeof sub !== 'string' ||
      !UUID.test(sub) ||
      typeof familyId !== 'string' ||
      !UUID.test(familyId) ||
      tokenUse !== ACCESS_TOKEN_USE ||
      typeof exp !== 'number'
    ) {
      throw invalidToken();
    }
    return { userId: sub, refreshTokenFamilyId: familyId, expiresAt: new Date(exp * 1000) };
  }

  private decodeHeader(token: string): { alg?: unknown; kid?: unknown } | undefined {
    try {
      const decoded = this.jwt.decode<{ header?: { alg?: unknown; kid?: unknown } } | null>(token, { complete: true });
      return decoded?.header;
    } catch {
      return undefined;
    }
  }
}

function invalidToken(): UnauthenticatedError {
  return new UnauthenticatedError('Authentication is required.');
}
