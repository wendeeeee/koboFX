import { EntityManager } from 'typeorm';

export enum FlowType {
  FUNDING = 'FUNDING',
  /** Synchronous: created and completed in one transaction, so the resumer never sees one (Phase 7). */
  CONVERSION = 'CONVERSION',
  /** Card funding through Paystack's hosted checkout (PAYSTACK_PLAN.md C2): no authorize/capture split. */
  PAYSTACK_FUNDING = 'PAYSTACK_FUNDING',
}

/** A `flow_instances` row (design §7.5). */
export interface FlowInstance {
  readonly id: string;
  readonly flowType: FlowType;
  readonly state: string;
  readonly userId: string;
  readonly context: Record<string, unknown>;
  /** Attempts at the current state (reset by every transition). */
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly stateChangedAt: Date;
  readonly completedAt: Date | null;
  readonly lastError: string | null;
}

/** A flow this worker holds the lease on. `leaseToken` fences every commit. */
export interface ClaimedFlow extends FlowInstance {
  readonly leaseToken: string;
}

/**
 * The step boundaries crash-and-resume injection targets (design §11): after the
 * step's external call(s) and before its transaction; inside the transaction just
 * before it commits; after the commit and before the next step.
 */
export enum FlowCheckpoint {
  AFTER_EXTERNAL_CALL = 'AFTER_EXTERNAL_CALL',
  BEFORE_COMMIT = 'BEFORE_COMMIT',
  AFTER_COMMIT = 'AFTER_COMMIT',
}

/** What a step's commit changes besides its own writes. */
export interface FlowChange {
  /** The new state; omitted = the flow stays where it is (progress within a state). */
  readonly to?: string;
  /** Set `completed_at` (once): the resumer has no more work for this flow. */
  readonly complete?: boolean;
  /** When the flow is next due; default: immediately. */
  readonly retryInSeconds?: number;
  readonly note?: string;
}

/** Given to a step by the runner: the only way a step commits. */
export interface FlowStepRuntime {
  checkpoint(point: FlowCheckpoint): Promise<void>;
  /**
   * ONE transaction: lock the flow row, verify it is still in `expectedState` and still
   * leased by us, run `work` (ledger postings, row updates, audit), apply `change`,
   * release the lease. Throws `FlowLeaseLostError` / `StaleFlowStateError` otherwise.
   */
  commit(expectedState: string, change: FlowChange, work?: (manager: EntityManager) => Promise<void>): Promise<void>;
}

export type StepOutcome =
  | { readonly kind: 'TRANSITIONED'; readonly from: string; readonly to: string }
  | { readonly kind: 'PROGRESSED'; readonly state: string }
  /** Nothing to do in this state (e.g. a completed flow poked by a stale webhook). */
  | { readonly kind: 'IDLE'; readonly state: string }
  | { readonly kind: 'WAITING'; readonly state: string; readonly reason: string; readonly retryInSeconds?: number };

/** A durable state machine: a transition table and one step per non-terminal state. */
export interface FlowDefinition {
  readonly flowType: FlowType;
  /** Run the step for the flow's current state. Idempotent: it may be re-run after a crash. */
  step(flow: ClaimedFlow, runtime: FlowStepRuntime): Promise<StepOutcome>;
  /** Has the flow reached (or passed) what a webhook of this type hinted at? */
  isHintSatisfied(state: string, eventType: string): boolean;
}
