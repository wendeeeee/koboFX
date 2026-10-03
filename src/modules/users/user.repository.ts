import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { UserRole, UserStatus } from './user.types';

export interface UserProfile {
  readonly id: string;
  readonly email: string;
  readonly status: UserStatus;
  readonly role: UserRole;
  readonly verifiedAt: Date | null;
  readonly createdAt: Date;
}

export interface UserCredentials extends UserProfile {
  readonly passwordHash: string;
}


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


@Injectable()
export class UserRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

 
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
