import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { RequestContext } from '../../../common/context';
import { exponentialBackoffSeconds } from '../../../common/polling/backoff';
import { PollingLoop } from '../../../common/polling/polling-loop';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { FlowRunner } from '../../flows/flow-runner';
import { FlowRepository } from '../../flows/flow.repository';
import { FundingPaymentRepository } from '../../flows/funding/funding-payment.repository';
import { WebhookHint, parseWebhookHint } from './webhook-payload';
import { ResolvedWebhook, WebhookResolverRegistry } from './webhook-resolvers';

export enum WebhookEventOutcome {
  ADVANCED = 'ADVANCED',
  NO_CHANGE = 'NO_CHANGE',
  UNMATCHED = 'UNMATCHED',
  UNCONFIRMED = 'UNCONFIRMED',
  MALFORMED = 'MALFORMED',
}

interface ClaimedWebhookEvent {
  readonly id: string;
  readonly provider: string;
  readonly rawPayload: Buffer;
  /** Including this one. */
  readonly attempts: number;
}

export interface WebhookProcessingReport {
  readonly claimed: number;
  readonly finished: number;
  readonly retried: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRY_BASE_SECONDS = 2;
const RETRY_MAXIMUM_SECONDS = 300;
const MAXIMUM_ERROR_LENGTH = 500;

@Injectable()
export class WebhookProcessor {
  private readonly logger = new Logger(WebhookProcessor.name);
  private readonly loop: PollingLoop;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly runner: FlowRunner,
    private readonly flows: FlowRepository,
    private readonly fundingPayments: FundingPaymentRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly resolvers: WebhookResolverRegistry,
  ) {
    this.loop = new PollingLoop(
      WebhookProcessor.name,
      async () => ({ fullBatch: (await this.processDue()).claimed >= this.config.flows.batchSize }),
      () => this.config.flows.pollIntervalMilliseconds,
    );
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  async processDue(batchSize = this.config.flows.batchSize): Promise<WebhookProcessingReport> {
    const events = await this.claim(batchSize);
    let finished = 0;
    for (const event of events) {
      const done = await RequestContext.run({ correlationId: `webhook-${randomUUID()}` }, () => this.process(event));
      if (done) finished += 1;
    }
    return { claimed: events.length, finished, retried: events.length - finished };
  }

  private async process(event: ClaimedWebhookEvent): Promise<boolean> {
    try {
      const resolved = await this.resolve(event);
      if (resolved === 'NO_RESOLVER') return await this.retryOrGiveUp(event, `no webhook resolver for provider ${event.provider}`);
      if (!resolved) return await this.finish(event, WebhookEventOutcome.MALFORMED, null);
      const hint = resolved;
      const flowId = resolved.flowId;
      const flow = flowId ? await this.flows.findById(flowId) : null;
      if (!flow) {
        this.logger.warn({ webhookEventId: event.id, eventType: hint.eventType }, 'Webhook for a payment we do not know');
        return await this.finish(event, WebhookEventOutcome.UNMATCHED, null);
      }
      const definition = this.runner.definitionFor(flow.flowType);
      if (definition.isHintSatisfied(flow.state, hint.eventType)) {
        return await this.finish(event, WebhookEventOutcome.NO_CHANGE, null);
      }

      const result = await this.runner.advance(flow.id, { includeCompleted: true });
      const after = await this.flows.findById(flow.id);
      const state = after?.state ?? flow.state;
      if (definition.isHintSatisfied(state, hint.eventType)) {
        return await this.finish(event, state !== flow.state ? WebhookEventOutcome.ADVANCED : WebhookEventOutcome.NO_CHANGE, null);
      }
      const reason =
        result.kind === 'NOT_CLAIMED'
          ? `flow ${flow.id} is being advanced by another worker`
          : `flow in ${state}; the PSP's API has not confirmed ${hint.eventType} yet`;
      return await this.retryOrGiveUp(event, reason);
    } catch (error) {
      this.logger.error({ webhookEventId: event.id, err: error }, 'Webhook processing failed; will retry');
      return this.retryOrGiveUp(event, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
  }


  private async resolve(event: ClaimedWebhookEvent): Promise<ResolvedWebhook | undefined | 'NO_RESOLVER'> {
    if (event.provider === this.config.paymentProvider.name) {
      const hint = parseWebhookHint(event.rawPayload);
      if (!hint) return undefined;
      return { eventType: hint.eventType, flowId: await this.findFlowId(hint) };
    }
    const resolver = this.resolvers.find(event.provider);
    if (!resolver) return 'NO_RESOLVER';
    return resolver.resolve(event.rawPayload);
  }

  private async findFlowId(hint: WebhookHint): Promise<string | null> {
    const byPayment = await this.fundingPayments.findFlowIdByProviderPayment(this.config.paymentProvider.name, hint.paymentId);
    if (byPayment) return byPayment;
   
    return hint.reference && UUID.test(hint.reference) ? hint.reference : null;
  }

  private async retryOrGiveUp(event: ClaimedWebhookEvent, reason: string): Promise<boolean> {
    if (event.attempts >= this.config.flows.webhookMaxAttempts) {
      this.logger.warn({ webhookEventId: event.id, reason }, 'Webhook hint never confirmed by the PSP; closing it');
      return this.finish(event, WebhookEventOutcome.UNCONFIRMED, reason);
    }
    await this.unitOfWork.manager.query(
      `UPDATE webhook_events SET next_attempt_at = now() + make_interval(secs => $2), last_error = $3
        WHERE id = $1 AND processed_at IS NULL`,
      [event.id, exponentialBackoffSeconds(event.attempts, RETRY_BASE_SECONDS, RETRY_MAXIMUM_SECONDS), reason.slice(0, MAXIMUM_ERROR_LENGTH)],
    );
    return false;
  }

  private async finish(event: ClaimedWebhookEvent, outcome: WebhookEventOutcome, reason: string | null): Promise<boolean> {
    await this.unitOfWork.manager.query(
      `UPDATE webhook_events SET processed_at = now(), outcome = $2, last_error = $3 WHERE id = $1 AND processed_at IS NULL`,
      [event.id, outcome, reason?.slice(0, MAXIMUM_ERROR_LENGTH) ?? null],
    );
    return true;
  }

  private async claim(batchSize: number): Promise<ClaimedWebhookEvent[]> {
    const rows = (await this.unitOfWork.manager.query(
      `WITH due AS (
         SELECT id FROM webhook_events
          WHERE processed_at IS NULL AND signature_valid AND next_attempt_at <= now()
          ORDER BY next_attempt_at, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE webhook_events
            SET attempts = webhook_events.attempts + 1, next_attempt_at = now() + make_interval(secs => $2)
           FROM due
          WHERE webhook_events.id = due.id
         RETURNING webhook_events.id, webhook_events.provider, webhook_events.raw_payload, webhook_events.attempts,
                   webhook_events.received_at
       )
       SELECT * FROM claimed ORDER BY received_at, id`,
      [batchSize, this.config.flows.leaseSeconds],
    )) as { id: string; provider: string; raw_payload: Buffer; attempts: number }[];
    return rows.map((row) => ({ id: row.id, provider: row.provider, rawPayload: row.raw_payload, attempts: row.attempts }));
  }
}
