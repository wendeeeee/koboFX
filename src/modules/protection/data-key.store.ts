import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { KeyRing } from '../../common/crypto/key-ring';
import { open, seal, SealingContext } from '../../common/crypto/sealing';
import { DependencyUnavailableError, InvariantViolationError } from '../../common/errors';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { AuditAction, AuditActor, AuditLogService, AuditSubjectType } from '../audit/audit-log.service';

export enum DataKeyPurpose {
  USER_DESTINATION = 'USER_DESTINATION',
  PROVIDER_EVIDENCE = 'PROVIDER_EVIDENCE',
}

export interface DataKey {
  readonly id: string;
  readonly key: Buffer;
}

interface DataKeyRow {
  id: string;
  purpose: DataKeyPurpose;
  user_id: string | null;
  wrapped_key: Buffer;
  key_encryption_key_id: string;
}

function wrappingContext(row: { id: string; purpose: DataKeyPurpose; user_id: string | null }): SealingContext {
  return { table: 'data_encryption_keys', column: 'wrapped_key', rowId: row.id, ownerId: row.user_id ?? row.purpose };
}

/**
 * Data keys (WITHDRAWAL_PLAN.md §H; D6): one per user for destination PII, one for provider evidence. Generated here,
 * stored only WRAPPED under the active key-encryption key, unwrapped on use (cached per process: they never change).
 *
 * Rotation of a key-encryption key = configure the new one as active, keep the old one in the ring, `rewrap` every row
 * that names the old one (audited), then retire it. Sealed financial facts are never rewritten. A key-encryption key
 * that is missing from the ring is an explicit `DEPENDENCY_UNAVAILABLE`, never a plaintext fallback.
 */
@Injectable()
export class DataKeyStore {
  private readonly unwrapped = new Map<string, Buffer>();

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditLogService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private ring(): KeyRing {
    const ring = this.config.protection.keyEncryption;
    if (!ring) {
      throw new DependencyUnavailableError('Protected data needs WITHDRAWAL_KEY_ENCRYPTION_KEYS, which is not configured.', {
        dependency: 'key-encryption-keys',
      });
    }
    return ring;
  }

  private keyEncryptionKey(keyId: string): Buffer {
    const key = this.ring().keys.get(keyId);
    if (!key) {
      throw new DependencyUnavailableError('A data key is wrapped under a key-encryption key that is not configured.', {
        dependency: 'key-encryption-keys',
        keyEncryptionKeyId: keyId,
      });
    }
    return key;
  }

  /** The user's destination key, created (in the ambient transaction) on first use. */
  async forUser(userId: string): Promise<DataKey> {
    return this.findOrCreate(DataKeyPurpose.USER_DESTINATION, userId.toLowerCase());
  }

  async forEvidence(): Promise<DataKey> {
    return this.findOrCreate(DataKeyPurpose.PROVIDER_EVIDENCE, null);
  }

  /** The key a sealed value names (`sealing_key_id`, `key_id`, `payload_key_id`). */
  async byId(keyId: string): Promise<DataKey> {
    const cached = this.unwrapped.get(keyId);
    if (cached) return { id: keyId, key: cached };
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT id, purpose, user_id, wrapped_key, key_encryption_key_id FROM data_encryption_keys WHERE id = $1`,
      [keyId],
    )) as DataKeyRow[];
    if (!row) throw new InvariantViolationError('A sealed value names a data key that does not exist.', { keyId });
    return this.unwrap(row);
  }

  /**
   * Rewrap one data key under the ACTIVE key-encryption key, in one transaction with its audit row. Returns false when
   * it is already wrapped under the active key (nothing changes, nothing is audited).
   */
  async rewrap(keyId: string, actor: AuditActor, reason: string): Promise<boolean> {
    const ring = this.ring();
    return this.unitOfWork.run(async (manager) => {
      const [row] = (await manager.query(
        `SELECT id, purpose, user_id, wrapped_key, key_encryption_key_id FROM data_encryption_keys WHERE id = $1 FOR UPDATE`,
        [keyId],
      )) as DataKeyRow[];
      if (!row) throw new InvariantViolationError('No such data key.', { keyId });
      if (row.key_encryption_key_id === ring.activeKeyId) return false;
      const { key } = this.unwrap(row);
      const rewrapped = seal(this.keyEncryptionKey(ring.activeKeyId), key, wrappingContext(row));
      await manager.query(
        `UPDATE data_encryption_keys SET wrapped_key = $2, key_encryption_key_id = $3, rewrapped_at = clock_timestamp() WHERE id = $1`,
        [keyId, rewrapped, ring.activeKeyId],
      );
      await this.audit.record({
        actor,
        action: AuditAction.DATA_KEY_REWRAPPED,
        subject: { type: AuditSubjectType.DATA_ENCRYPTION_KEY, id: keyId },
        before: { keyEncryptionKeyId: row.key_encryption_key_id },
        after: { keyEncryptionKeyId: ring.activeKeyId },
        reason,
      });
      return true;
    });
  }

  /** Data keys still wrapped under a key other than the active one: the rotation's remaining work. */
  async staleKeyIds(limit = 500): Promise<string[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT id FROM data_encryption_keys WHERE key_encryption_key_id <> $1 ORDER BY id LIMIT $2`,
      [this.ring().activeKeyId, limit],
    )) as { id: string }[];
    return rows.map((row) => row.id);
  }

  private async findOrCreate(purpose: DataKeyPurpose, userId: string | null): Promise<DataKey> {
    const manager = this.unitOfWork.manager;
    const existing = await this.find(manager, purpose, userId);
    if (existing) return this.unwrap(existing);

    const ring = this.ring();
    const id = randomUUID();
    const key = randomBytes(32);
    const wrapped = seal(this.keyEncryptionKey(ring.activeKeyId), key, wrappingContext({ id, purpose, user_id: userId }));
    const conflictTarget =
      purpose === DataKeyPurpose.USER_DESTINATION ? `(user_id) WHERE purpose = 'USER_DESTINATION'` : `(purpose) WHERE purpose = 'PROVIDER_EVIDENCE'`;
    await manager.query(
      `INSERT INTO data_encryption_keys (id, purpose, user_id, wrapped_key, key_encryption_key_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ${conflictTarget} DO NOTHING`,
      [id, purpose, userId, wrapped, ring.activeKeyId],
    );
    const row = await this.find(manager, purpose, userId);
    if (!row) throw new InvariantViolationError('A data key vanished right after it was created.', { purpose });
    return this.unwrap(row);
  }

  private async find(manager: EntityManager, purpose: DataKeyPurpose, userId: string | null): Promise<DataKeyRow | undefined> {
    const [row] = (await manager.query(
      `SELECT id, purpose, user_id, wrapped_key, key_encryption_key_id FROM data_encryption_keys
        WHERE purpose = $1 AND user_id IS NOT DISTINCT FROM $2::uuid`,
      [purpose, userId],
    )) as DataKeyRow[];
    return row;
  }

  private unwrap(row: DataKeyRow): DataKey {
    const cached = this.unwrapped.get(row.id);
    if (cached) return { id: row.id, key: cached };
    const key = open(this.keyEncryptionKey(row.key_encryption_key_id), row.wrapped_key, wrappingContext(row));
    this.unwrapped.set(row.id, key);
    return { id: row.id, key };
  }
}
