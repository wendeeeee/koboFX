import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { SEALING_CODEC_VERSION, SealingContext } from '../../common/crypto/sealing';
import { InvariantViolationError } from '../../common/errors';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { ProtectionService, sha256 } from './protection.service';

export interface EvidenceInput {
  readonly provider: 'paystack';
  /** `transfer.verify`, `bank.resolve`, `webhook.transfer`, … (dot-separated, lowercase). */
  readonly operation: string;
  /** The exact bytes received. Never re-serialised JSON. */
  readonly content: Buffer;
  readonly providerCallId?: string;
  readonly webhookEventId?: string;
}

export interface StoredEvidence {
  readonly evidenceId: string;
  readonly contentSha256: Buffer;
}

const contextOf = (evidenceId: string): SealingContext => ({
  table: 'protected_provider_evidence',
  column: 'sealed_content',
  rowId: evidenceId,
  provider: 'paystack',
});

/**
 * `protected_provider_evidence` (WITHDRAWAL_PLAN.md §D.1, §H): the exact bytes a provider sent, sealed under the
 * evidence data key, with the digest of the plaintext. Written in the AMBIENT transaction: an observation and its
 * evidence commit together, or neither does (a storage failure keeps the hold and re-verifies, §G.1 step 5). Nothing
 * here is exposed to a customer endpoint.
 */
@Injectable()
export class ProtectedEvidenceService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly protection: ProtectionService,
  ) {}

  async store(input: EvidenceInput): Promise<StoredEvidence> {
    const evidenceId = randomUUID();
    const contentSha256 = sha256(input.content);
    const sealed = await this.protection.sealEvidence(input.content, contextOf(evidenceId));
    await this.unitOfWork.manager.query(
      `INSERT INTO protected_provider_evidence
         (id, provider, environment, operation, codec_version, key_id, sealed_content, content_sha256, content_length,
          provider_call_id, webhook_event_id)
       VALUES ($1, $2, 'test', $3, $4, $5, $6, $7, $8, $9, $10)`,
      [evidenceId, input.provider, input.operation, SEALING_CODEC_VERSION, sealed.keyId, sealed.sealed, contentSha256,
        input.content.length, input.providerCallId ?? null, input.webhookEventId ?? null],
    );
    return { evidenceId, contentSha256 };
  }

  /** For investigation and tests only: the exact bytes, checked against the stored digest. */
  async read(evidenceId: string): Promise<Buffer> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT key_id, sealed_content, content_sha256 FROM protected_provider_evidence WHERE id = $1`,
      [evidenceId],
    )) as { key_id: string; sealed_content: Buffer; content_sha256: Buffer }[];
    if (!row) throw new InvariantViolationError('No such evidence.', { evidenceId });
    const content = await this.protection.open({ keyId: row.key_id, sealed: row.sealed_content }, contextOf(evidenceId));
    if (!sha256(content).equals(row.content_sha256)) {
      throw new InvariantViolationError('Evidence content does not match its stored digest.', { evidenceId });
    }
    return content;
  }
}
