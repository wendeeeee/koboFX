import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { UserRole, UserStatus } from './user.types';

/** What a caller may see about a user. Never carries the password hash. */
export interface UserProfile {
  readonly id: string;
  readonly email: string;
  readonly status: UserStatus;
  readonly role: UserRole;
  readonly verifiedAt: Date | null;
  readonly createdAt: Date;
}

/** Only for credential checks inside the auth module. */
export interface UserCredentials extends UserProfile {
  readonly passwordHash: string;
}

/**
 * The state every authenticated request re-reads (decision #8): status and role
 * come from the database, never from token claims, and the session (refresh token
 * family) the access token belongs to must not be revoked.
 */
export interface AuthenticationState {
  readonly userId: string;
  readonly status: UserStatus;
  readonly role: UserRole;
  readonly sessionRevoked: boolean;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  status: UserStatus;
  role: UserRole;
  verified_at: Date | null;
  created_at: Date;
}

const PROFILE_COLUMNS = `id, email, status, role, verified_at, created_at`;

function toProfile(row: UserRow): UserProfile {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    role: row.role,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
  };
}

/**
 * `users` access. Every method runs on the ambient UnitOfWork manager, so it joins
 * the caller's transaction when there is one. Emails passed in are already normalised
 * (`normalizeEmailAddress`); the table's CHECK refuses anything else.
 */
@Injectable()
export class UserRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /**
   * Insert a PENDING_VERIFICATION user, or nothing if the email is taken. A single
   * statement: concurrent registrations of one email serialise on the unique index,
   * and exactly one gets a row back.
   */
  async insertPending(email: string, passwordHash: string): Promise<string | null> {
    const rows = (await this.unitOfWork.manager.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [email, passwordHash],
    )) as { id: string }[];
    return rows[0]?.id ?? null;
  }

  async findCredentialsByEmail(email: string): Promise<UserCredentials | null> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT ${PROFILE_COLUMNS}, password_hash FROM users WHERE email = $1`,
      [email],
    )) as UserRow[];
    return row ? { ...toProfile(row), passwordHash: row.password_hash } : null;
  }

  /** Row-locks the user until the surrounding transaction ends. */
  async lockByEmail(email: string): Promise<UserProfile> {
    const manager = this.unitOfWork.requireTransaction();
    const [row] = (await manager.query(`SELECT ${PROFILE_COLUMNS} FROM users WHERE email = $1 FOR UPDATE`, [
      email,
    ])) as UserRow[];
    return toProfile(row);
  }

  async findProfile(userId: string): Promise<UserProfile | null> {
    const [row] = (await this.unitOfWork.manager.query(`SELECT ${PROFILE_COLUMNS} FROM users WHERE id = $1`, [
      userId,
    ])) as UserRow[];
    return row ? toProfile(row) : null;
  }

  async replacePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.unitOfWork.manager.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, passwordHash]);
  }

  /**
   * PENDING_VERIFICATION → ACTIVE, conditionally: only one caller can ever win. Returns
   * the verified profile, or null when the user was not pending.
   */
  async activate(userId: string): Promise<UserProfile | null> {
    const [row] = (await this.unitOfWork.manager.query(
      `WITH updated AS (
         UPDATE users SET status = 'ACTIVE', verified_at = now()
          WHERE id = $1 AND status = 'PENDING_VERIFICATION'
         RETURNING ${PROFILE_COLUMNS}
       )
       SELECT * FROM updated`,
      [userId],
    )) as UserRow[];
    return row ? toProfile(row) : null;
  }

  /** One primary-key lookup joining the user to the session the token belongs to. */
  async findAuthenticationState(userId: string, familyId: string): Promise<AuthenticationState | null> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT users.id, users.status, users.role, refresh_token_families.revoked_at IS NOT NULL AS session_revoked
         FROM users
         JOIN refresh_token_families ON refresh_token_families.user_id = users.id
        WHERE users.id = $1 AND refresh_token_families.id = $2`,
      [userId, familyId],
    )) as { id: string; status: UserStatus; role: UserRole; session_revoked: boolean }[];
    return row ? { userId: row.id, status: row.status, role: row.role, sessionRevoked: row.session_revoked } : null;
  }
}
