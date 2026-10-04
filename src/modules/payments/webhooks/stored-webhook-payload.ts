import { Injectable } from '@nestjs/common';
import { SealingContext } from '../../../common/crypto/sealing';
import { InvariantViolationError } from '../../../common/errors';
import { ProtectionService, sha256 } from '../../protection/protection.service';

export enum WebhookPayloadEncoding {
  PLAINTEXT_V1 = 'PLAINTEXT_V1',
  SEALED_V1 = 'SEALED_V1',
}

/** The columns a reader needs: SELECT them wherever a stored payload is read. */
export const STORED_PAYLOAD_COLUMNS = `webhook_events.raw_payload, webhook_events.payload_encoding, webhook_events.payload_key_id,
  webhook_events.payload_sha256`;

export interface StoredWebhookPayloadRow {
  readonly id: string;
  readonly raw_payload: Buffer;
  readonly payload_encoding: WebhookPayloadEncoding;
  readonly payload_key_id: string | null;
  readonly payload_sha256: Buffer | null;
}

export function webhookPayloadContext(webhookEventId: string): SealingContext {
  return { table: 'webhook_events', column: 'raw_payload', rowId: webhookEventId, provider: 'paystack' };
}

/**
 * Reads a stored webhook payload back to the EXACT bytes that were signed (WITHDRAWAL_PLAN.md §H): a legacy or
 * plaintext row as stored; a sealed row opened with its data key and checked against the digest taken before sealing.
 * Any mismatch throws — a payload is never "probably" the one received.
 */
@Injectable()
export class StoredWebhookPayloadReader {
  constructor(private readonly protection: ProtectionService) {}

  async read(row: StoredWebhookPayloadRow): Promise<Buffer> {
    if (row.payload_encoding === WebhookPayloadEncoding.PLAINTEXT_V1) return row.raw_payload;
    if (row.payload_encoding !== WebhookPayloadEncoding.SEALED_V1 || !row.payload_key_id || !row.payload_sha256) {
      throw new InvariantViolationError('A stored webhook payload has an unknown or incomplete envelope.', { webhookEventId: row.id });
    }
    const plaintext = await this.protection.open({ keyId: row.payload_key_id, sealed: row.raw_payload }, webhookPayloadContext(row.id));
    if (!sha256(plaintext).equals(row.payload_sha256)) {
      throw new InvariantViolationError('A sealed webhook payload does not match its stored digest.', { webhookEventId: row.id });
    }
    return plaintext;
  }
}
