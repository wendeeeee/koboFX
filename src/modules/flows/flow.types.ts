import { EntityManager } from 'typeorm';

export enum FlowType {
  FUNDING = 'FUNDING',

  CONVERSION = 'CONVERSION',
 
  PAYSTACK_FUNDING = 'PAYSTACK_FUNDING',

  PAYSTACK_BENEFICIARY = 'PAYSTACK_BENEFICIARY',

  PAYSTACK_WITHDRAWAL = 'PAYSTACK_WITHDRAWAL',
}

export interface FlowInstance {
  readonly id: string;
  readonly flowType: FlowType;
  readonly state: string;
  readonly userId: string;
  readonly context: Record<string, unknown>;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly stateChangedAt: Date;
  readonly completedAt: Date | null;
  readonly lastError: string | null;
}

export interface ClaimedFlow extends FlowInstance {
  readonly leaseToken: string;
}


export enum FlowCheckpoint {
  AFTER_EXTERNAL_CALL = 'AFTER_EXTERNAL_CALL',
  BEFORE_COMMIT = 'BEFORE_COMMIT',
  AFTER_COMMIT = 'AFTER_COMMIT',
}

export interface FlowChange {
  readonly to?: string;
  readonly complete?: boolean;
  readonly retryInSeconds?: number;
  readonly note?: string;
}

/**
 * `lockOwnerFirst`: take the flow owner's `users` row `FOR SHARE` BEFORE the flow row (global order: users → flow),
 * so the step's work reads an eligibility a concurrent suspension cannot change until commit. For a withdrawal's
 * submission marker and unsent cancellation (WITHDRAWAL_PLAN.md §G.1 step 3); other flows keep the plain commit.
 */
export interface FlowCommitOptions {
  readonly lockOwnerFirst?: boolean;
}

export interface FlowStepRuntime {
  checkpoint(point: FlowCheckpoint): Promise<void>;
  commit(
    expectedState: string,
    change: FlowChange,
    work?: (manager: EntityManager) => Promise<void>,
    options?: FlowCommitOptions,
  ): Promise<void>;
}

export type StepOutcome =
  | { readonly kind: 'TRANSITIONED'; readonly from: string; readonly to: string }
  | { readonly kind: 'PROGRESSED'; readonly state: string }
  | { readonly kind: 'IDLE'; readonly state: string }
  | { readonly kind: 'WAITING'; readonly state: string; readonly reason: string; readonly retryInSeconds?: number };

export interface FlowDefinition {
  readonly flowType: FlowType;
  step(flow: ClaimedFlow, runtime: FlowStepRuntime): Promise<StepOutcome>;
  isHintSatisfied(state: string, eventType: string): boolean;
}
