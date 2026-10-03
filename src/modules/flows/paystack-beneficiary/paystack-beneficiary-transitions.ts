import { InvariantViolationError } from '../../../common/errors';

/**
 * The `PAYSTACK_BENEFICIARY` preparation state machine (WITHDRAWAL_PLAN.md §E.1). The TypeScript mirror of the
 * `PAYSTACK_BENEFICIARY` branch of SQL `flow_transition_allowed`, tested equal pair for pair. READY is final: a changed
 * destination is a new beneficiary. Review is an orthogonal condition, not a state. No money is reserved here.
 */
export enum PaystackBeneficiaryState {
  REQUESTED = 'REQUESTED',
  RESOLVED = 'RESOLVED',
  CREATING = 'CREATING',
  READY = 'READY',
  FAILED = 'FAILED',
}

export type BeneficiaryStatus = 'PENDING' | 'READY' | 'FAILED';

export const PAYSTACK_BENEFICIARY_TRANSITIONS: Readonly<Record<PaystackBeneficiaryState, readonly PaystackBeneficiaryState[]>> = {
  [PaystackBeneficiaryState.REQUESTED]: [PaystackBeneficiaryState.RESOLVED, PaystackBeneficiaryState.FAILED],
  [PaystackBeneficiaryState.RESOLVED]: [PaystackBeneficiaryState.CREATING, PaystackBeneficiaryState.FAILED],
  [PaystackBeneficiaryState.CREATING]: [PaystackBeneficiaryState.READY, PaystackBeneficiaryState.FAILED],
  [PaystackBeneficiaryState.READY]: [],
  [PaystackBeneficiaryState.FAILED]: [],
};

export const PAYSTACK_BENEFICIARY_STATES: readonly PaystackBeneficiaryState[] = Object.values(PaystackBeneficiaryState);

export const PAYSTACK_BENEFICIARY_COMPLETION_STATES: readonly PaystackBeneficiaryState[] = [
  PaystackBeneficiaryState.READY,
  PaystackBeneficiaryState.FAILED,
];

export function isPaystackBeneficiaryState(value: string): value is PaystackBeneficiaryState {
  return (PAYSTACK_BENEFICIARY_STATES as readonly string[]).includes(value);
}

export function assertBeneficiaryTransition(from: PaystackBeneficiaryState, to: PaystackBeneficiaryState): void {
  if (!PAYSTACK_BENEFICIARY_TRANSITIONS[from].includes(to)) {
    throw new InvariantViolationError(`A Paystack beneficiary cannot move from ${from} to ${to}.`, { from, to });
  }
}

export function beneficiaryStatusOf(state: PaystackBeneficiaryState): BeneficiaryStatus {
  switch (state) {
    case PaystackBeneficiaryState.REQUESTED:
    case PaystackBeneficiaryState.RESOLVED:
    case PaystackBeneficiaryState.CREATING:
      return 'PENDING';
    case PaystackBeneficiaryState.READY:
      return 'READY';
    case PaystackBeneficiaryState.FAILED:
      return 'FAILED';
  }
}
