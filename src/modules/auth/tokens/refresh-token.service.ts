import { Inject, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Clock } from '../../../common/clock';
import { UnauthenticatedError } from '../../../common/errors';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { AuditAction, AuditActor, AuditLogService, AuditSubjectType } from '../../audit/audit-log.service';
import { UserStatus } from '../../users/user.types';
import {
  RefreshTokenRevocationReason,
  decideRotation,
  generateRefreshToken,
  hashRefreshToken,
  isWellFormedRefreshToken,
} from './refresh-token-rotation';

export interface IssuedRefreshToken {
  readonly token: string;
  readonly expiresAt: Date;
  readonly familyId: string;
}

export interface RotatedSession {
  readonly userId: string;
  readonly refreshToken: IssuedRefreshToken;
}

type RotationOutcome = { readonly kind: 'ROTATED'; readonly session: RotatedSession } | { readonly kind: 'REFUSED' };

/**
 * Refresh tokens are opaque, stored as SHA-256 only, and rotated on every use
 */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);
  private readonly timeToLiveMilliseconds: number;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly auditLog: AuditLogService,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.timeToLiveMilliseconds = config.authentication.refreshTokenTimeToLiveSeconds * 1000;
  }

  async startFamily(userId: string): Promise<IssuedRefreshToken> {
    const manager = this.unitOfWork.requireTransaction();
    const now = this.clock.now();
    const [family] = (await manager.query(
      `INSERT INTO refresh_token_families (user_id, created_at) VALUES ($1, $2) RETURNING id`,
      [userId, now],
    )) as { id: string }[];
    return this.insertToken(manager, family.id, null, now);
  }

  async rotate(presentedToken: string): Promise<RotatedSession> {
    if (!isWellFormedRefreshToken(presentedToken)) throw sessionRefused();
    const tokenHash = hashRefreshToken(presentedToken);

    const outcome = await this.unitOfWork.run(async (manager): Promise<RotationOutcome> => {
      const [token] = (await manager.query(`SELECT id, family_id FROM refresh_tokens WHERE token_hash = $1`, [
        tokenHash,
      ])) as { id: string; family_id: string }[];
      if (!token) return { kind: 'REFUSED' };

      const [family] = (await manager.query(
        `SELECT refresh_token_families.user_id, refresh_token_families.revoked_at IS NOT NULL AS revoked, users.status
           FROM refresh_token_families
           JOIN users ON users.id = refresh_token_families.user_id
          WHERE refresh_token_families.id = $1
          FOR UPDATE OF refresh_token_families`,
        [token.family_id],
      )) as { user_id: string; revoked: boolean; status: UserStatus }[];
      const now = this.clock.now();
      const [current] = (await manager.query(
        `SELECT used_at IS NOT NULL AS used, expires_at <= $2 AS expired FROM refresh_tokens WHERE id = $1`,
        [token.id, now],
      )) as { used: boolean; expired: boolean }[];

      const decision = decideRotation({
        familyRevoked: family.revoked,
        tokenUsed: current.used,
        tokenExpired: current.expired,
        userActive: family.status === UserStatus.ACTIVE,
      });
      switch (decision.kind) {
        case 'REJECT':
          return { kind: 'REFUSED' };
        case 'REVOKE_FAMILY':
          await this.revokeLocked(manager, token.family_id, decision.reason, { type: 'SYSTEM' });
          this.logger.warn(
            { userId: family.user_id, refreshTokenFamilyId: token.family_id, reason: decision.reason },
            'Refresh token family revoked',
          );
          return { kind: 'REFUSED' };
        case 'ROTATE': {
          await manager.query(`UPDATE refresh_tokens SET used_at = $2 WHERE id = $1`, [token.id, now]);
          const child = await this.insertToken(manager, token.family_id, token.id, now);
          return { kind: 'ROTATED', session: { userId: family.user_id, refreshToken: child } };
        }
      }
    });
    if (outcome.kind === 'REFUSED') throw sessionRefused();
    return outcome.session;
  }

  /**
   * Revoke a session (logout)
   */
  async revokeFamily(
    familyId: string,
    userId: string,
    reason: RefreshTokenRevocationReason,
    actor: AuditActor,
  ): Promise<boolean> {
    return this.unitOfWork.run(async (manager) => {
      const [family] = (await manager.query(
        `SELECT id FROM refresh_token_families WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL FOR UPDATE`,
        [familyId, userId],
      )) as { id: string }[];
      if (!family) return false;
      await this.revokeLocked(manager, familyId, reason, actor);
      return true;
    });
  }


  async revokeAllForUser(userId: string, reason: RefreshTokenRevocationReason, actor: AuditActor): Promise<number> {
    return this.unitOfWork.run(async (manager) => {
      const families = (await manager.query(
        `SELECT id FROM refresh_token_families WHERE user_id = $1 AND revoked_at IS NULL ORDER BY id FOR UPDATE`,
        [userId],
      )) as { id: string }[];
      for (const family of families) await this.revokeLocked(manager, family.id, reason, actor);
      return families.length;
    });
  }

  private async revokeLocked(
    manager: EntityManager,
    familyId: string,
    reason: RefreshTokenRevocationReason,
    actor: AuditActor,
  ): Promise<void> {
    await manager.query(
      `UPDATE refresh_token_families SET revoked_at = $2, revocation_reason = $3 WHERE id = $1 AND revoked_at IS NULL`,
      [familyId, this.clock.now(), reason],
    );
    await this.auditLog.record({
      actor,
      action: AuditAction.REFRESH_TOKEN_FAMILY_REVOKED,
      subject: { type: AuditSubjectType.REFRESH_TOKEN_FAMILY, id: familyId },
      before: { revoked: false },
      after: { revoked: true, revocationReason: reason },
      reason: `Refresh token family revoked: ${reason}`,
    });
  }

  private async insertToken(
    manager: EntityManager,
    familyId: string,
    parentId: string | null,
    now: Date,
  ): Promise<IssuedRefreshToken> {
    const token = generateRefreshToken();
    const expiresAt = new Date(now.getTime() + this.timeToLiveMilliseconds);
    await manager.query(
      `INSERT INTO refresh_tokens (family_id, parent_id, token_hash, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [familyId, parentId, hashRefreshToken(token), now, expiresAt],
    );
    return { token, expiresAt, familyId };
  }
}

function sessionRefused(): UnauthenticatedError {
  return new UnauthenticatedError('The session has expired or was revoked. Log in again.');
}
