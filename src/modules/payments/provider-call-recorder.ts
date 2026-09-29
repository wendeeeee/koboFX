import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestContext } from '../../common/context';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { redact } from './redaction';

export enum ProviderCallDirection {
  OUTBOUND = 'OUTBOUND',
  INBOUND = 'INBOUND',
}

export interface ProviderCallRecord {
  readonly provider: string;
  readonly operation: string;
  readonly direction: ProviderCallDirection;
  readonly flowId?: string;
  readonly webhookEventId?: string;
  readonly requestMethod?: string;
  readonly requestPath?: string;
  readonly attempt?: number;
  readonly requestBody?: unknown;
  readonly responseStatus?: number;
  readonly responseBody?: unknown;
  readonly durationMilliseconds?: number;
  readonly error?: string;
}

const MAXIMUM_ERROR_LENGTH = 1000;
const MAXIMUM_UNPARSED_BODY_LENGTH = 2000;

/** A body that is not JSON is still evidence: kept as text, inside a JSON wrapper. */
export function unparsedBody(text: string): { unparsed: string } {
  return { unparsed: text.slice(0, MAXIMUM_UNPARSED_BODY_LENGTH) };
}

/**
 * Writes `provider_calls` (design §7.2 point 4; handbook: store every request and
 * response). Bodies are redacted before insert (`redaction.ts`).
 *
 * An OUTBOUND record is written on the pool, never inside an ambient transaction: the
 * call happened whether or not the caller's work later commits. An INBOUND record is
 * written in the caller's transaction, with the webhook event it describes.
 */
@Injectable()
export class ProviderCallRecorder {
  private readonly logger = new Logger(ProviderCallRecorder.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async record(call: ProviderCallRecord): Promise<void> {
    const manager = call.direction === ProviderCallDirection.INBOUND ? this.unitOfWork.manager : this.dataSource.manager;
    await manager.query(
      `INSERT INTO provider_calls
         (provider, operation, direction, correlation_id, flow_id, webhook_event_id, request_method, request_path,
          attempt, request_body, response_status, response_body, duration_milliseconds, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        call.provider,
        call.operation,
        call.direction,
        RequestContext.correlationId() ?? `uncorrelated-${randomUUID()}`,
        call.flowId ?? null,
        call.webhookEventId ?? null,
        call.requestMethod ?? null,
        call.requestPath ?? null,
        call.attempt ?? 1,
        call.requestBody === undefined ? null : JSON.stringify(redact(call.requestBody)),
        call.responseStatus ?? null,
        call.responseBody === undefined ? null : JSON.stringify(redact(call.responseBody)),
        call.durationMilliseconds ?? null,
        call.error?.slice(0, MAXIMUM_ERROR_LENGTH) ?? null,
      ],
    );
  }

  /** For OUTBOUND calls: losing the evidence row must not turn a PSP answer into a failure. */
  async recordQuietly(call: ProviderCallRecord): Promise<void> {
    try {
      await this.record(call);
    } catch (error) {
      this.logger.error({ err: error, operation: call.operation, flowId: call.flowId }, 'Could not record a provider call');
    }
  }
}
