import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { RequestContext } from '../../common/context';
import { InvariantViolationError } from '../../common/errors';
import { exponentialBackoffSeconds } from '../../common/polling/backoff';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { ProviderUnavailableError } from '../payments/payment.errors';
import { FlowCheckpoints } from './flow-checkpoints';
import { FlowLeaseLostError } from './flow.errors';
import { FlowRepository } from './flow.repository';
import { ClaimedFlow, FlowCheckpoint, FlowDefinition, FlowStepRuntime, FlowType, StepOutcome } from './flow.types';

const BACKOFF_BASE_SECONDS = 5;

export type AdvanceResult =
  | { readonly kind: 'NOT_CLAIMED' }
  | { readonly kind: 'RAN'; readonly initialState: string; readonly finalState: string; readonly outcomes: readonly StepOutcome[] };


@Injectable()
export class FlowRunner {
  private readonly logger = new Logger(FlowRunner.name);
  private readonly definitions = new Map<FlowType, FlowDefinition>();

  constructor(
    private readonly repository: FlowRepository,
    private readonly checkpoints: FlowCheckpoints,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  register(definition: FlowDefinition): void {
    if (this.definitions.has(definition.flowType)) {
      throw new InvariantViolationError(`Two flow definitions registered for ${definition.flowType}.`);
    }
    this.definitions.set(definition.flowType, definition);
  }

  definitionFor(flowType: FlowType): FlowDefinition {
    const definition = this.definitions.get(flowType);
    if (!definition) throw new InvariantViolationError(`No flow definition registered for ${flowType}.`);
    return definition;
  }

  async advance(flowId: string, options: { maxSteps?: number; includeCompleted?: boolean } = {}): Promise<AdvanceResult> {
    const maxSteps = options.maxSteps ?? 10;
    const outcomes: StepOutcome[] = [];
    let initialState: string | undefined;
    let finalState: string | undefined;
    for (let step = 0; step < maxSteps; step += 1) {
      const flow = await this.repository.claimOne(flowId, this.config.flows.leaseSeconds, options.includeCompleted === true);
      if (!flow) break;
      initialState ??= flow.state;
      const outcome = await this.runClaimed(flow);
      outcomes.push(outcome);
      finalState = outcome.kind === 'TRANSITIONED' ? outcome.to : outcome.state;
      if (outcome.kind !== 'TRANSITIONED') break;
    }
    if (initialState === undefined || finalState === undefined) return { kind: 'NOT_CLAIMED' };
    return { kind: 'RAN', initialState, finalState, outcomes };
  }

  async applyExternalTransition(
    flowId: string,
    from: string,
    to: string,
    work: (manager: EntityManager) => Promise<void>,
  ): Promise<'APPLIED' | 'NOT_CLAIMED' | 'STALE'> {
    const flow = await this.repository.claimOne(flowId, this.config.flows.leaseSeconds, true);
    if (!flow) return 'NOT_CLAIMED';
    const keepSchedule = Math.max(0, Math.ceil((flow.nextAttemptAt.getTime() - Date.now()) / 1000));
    if (flow.state !== from) {
      await this.repository.release(flow, keepSchedule, flow.lastError);
      return 'STALE';
    }
    try {
      await this.repository.commit(
        flow,
        from,
        { to, complete: true, retryInSeconds: keepSchedule, ...(flow.lastError ? { note: flow.lastError } : {}) },
        work,
        () => this.checkpoints.reached(FlowCheckpoint.BEFORE_COMMIT, { flowId: flow.id, state: flow.state }),
      );
    } catch (error) {
      await this.repository.release(flow, keepSchedule, flow.lastError).catch(() => undefined);
      throw error;
    }
    return 'APPLIED';
  }

  async runClaimed(flow: ClaimedFlow): Promise<StepOutcome> {
    return RequestContext.run({ correlationId: `flow-step-${randomUUID()}` }, async () => {
      const definition = this.definitionFor(flow.flowType);
      const flowRef = { flowId: flow.id, state: flow.state };
      const runtime: FlowStepRuntime = {
        checkpoint: (point) => this.checkpoints.reached(point, flowRef),
        commit: (expectedState, change, work, options) =>
          this.repository.commit(
            flow,
            expectedState,
            change,
            work,
            () => this.checkpoints.reached(FlowCheckpoint.BEFORE_COMMIT, flowRef),
            options,
          ),
      };
      let outcome: StepOutcome;
      try {
        outcome = await definition.step(flow, runtime);
      } catch (error) {
        return this.recordFailure(flow, error);
      }
      if (outcome.kind === 'WAITING') {
        await this.repository.release(flow, outcome.retryInSeconds ?? this.backoff(flow.attempts), outcome.reason);
      } else if (outcome.kind === 'IDLE') {
        await this.repository.release(flow, this.backoff(flow.attempts), null);
      } else {
        await this.checkpoints.reached(FlowCheckpoint.AFTER_COMMIT, flowRef);
      }
      return outcome;
    });
  }

  private backoff(attempts: number): number {
    return exponentialBackoffSeconds(attempts, BACKOFF_BASE_SECONDS, this.config.flows.maximumBackoffSeconds);
  }

  private async recordFailure(flow: ClaimedFlow, error: unknown): Promise<StepOutcome> {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const context = { flowId: flow.id, flowType: flow.flowType, state: flow.state, attempts: flow.attempts };
    if (error instanceof FlowLeaseLostError) {
      this.logger.warn(context, 'Flow lease lost; step result discarded');
      return { kind: 'WAITING', state: flow.state, reason: message };
    }
    if (error instanceof ProviderUnavailableError) this.logger.warn({ ...context, err: error }, 'Flow step waiting on the PSP');
    else this.logger.error({ ...context, err: error }, 'Flow step failed; will retry');
    const retryInSeconds = this.backoff(flow.attempts);
    await this.repository.release(flow, retryInSeconds, message).catch((releaseError: unknown) => {
      this.logger.error({ ...context, err: releaseError }, 'Could not release a flow lease');
    });
    return { kind: 'WAITING', state: flow.state, reason: message, retryInSeconds };
  }
}
