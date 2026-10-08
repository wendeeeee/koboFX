import { InvariantViolationError } from '../../../common/errors';

/**
 * The `PAYSTACK_WITHDRAWAL` state machine (WITHDRAWAL_PLAN.md §E.2). The TypeScript mirror of the `PAYSTACK_WITHDRAWAL`
 * branch of SQL `flow_transition_allowed`, tested equal pair for pair. Same-state observations, backoff and review
 * updates are not transitions; every pair not listed is illegal (there is no RESERVED → POSTED shortcut).
 */
export enum PaystackWithdrawalState {
  RESERVED = 'RESERVED',
  SUBMITTING = 'SUBMITTING',
  PROCESSING = 'PROCESSING',
  POSTED = 'POSTED',
  FAILED = 'FAILED',
  REVERSED = 'REVERSED',
}

export type WithdrawalStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERSED';

export const PAYSTACK_WITHDRAWAL_TRANSITIONS: Readonly<Record<PaystackWithdrawalState, readonly PaystackWithdrawalState[]>> = {
  [PaystackWithdrawalState.RESERVED]: [PaystackWithdrawalState.SUBMITTING, PaystackWithdrawalState.FAILED],
  [PaystackWithdrawalState.SUBMITTING]: [
    PaystackWithdrawalState.PROCESSING,
    PaystackWithdrawalState.POSTED,
    PaystackWithdrawalState.FAILED,
  ],
  [PaystackWithdrawalState.PROCESSING]: [PaystackWithdrawalState.POSTED, PaystackWithdrawalState.FAILED],
  [PaystackWithdrawalState.POSTED]: [PaystackWithdrawalState.REVERSED],
  [PaystackWithdrawalState.FAILED]: [],
  [PaystackWithdrawalState.REVERSED]: [],
};

export const PAYSTACK_WITHDRAWAL_STATES: readonly PaystackWithdrawalState[] = Object.values(PaystackWithdrawalState);

/** No more resumer work. POSTED is still left by a full return (→ REVERSED), found by reconciliation. */
export const PAYSTACK_WITHDRAWAL_COMPLETION_STATES: readonly PaystackWithdrawalState[] = [
  PaystackWithdrawalState.POSTED,
  PaystackWithdrawalState.FAILED,
  PaystackWithdrawalState.REVERSED,
];

/** States in which the customer's protected hold must still be ACTIVE. */
export const PAYSTACK_WITHDRAWAL_HOLDING_STATES: readonly PaystackWithdrawalState[] = [
  PaystackWithdrawalState.RESERVED,
  PaystackWithdrawalState.SUBMITTING,
  PaystackWithdrawalState.PROCESSING,
];

export function isPaystackWithdrawalState(value: string): value is PaystackWithdrawalState {
  return (PAYSTACK_WITHDRAWAL_STATES as readonly string[]).includes(value);
}

export function assertWithdrawalTransition(from: PaystackWithdrawalState, to: PaystackWithdrawalState): void {
  if (!PAYSTACK_WITHDRAWAL_TRANSITIONS[from].includes(to)) {
    throw new InvariantViolationError(`A Paystack withdrawal cannot move from ${from} to ${to}.`, { from, to });
  }
}

export function paystackWithdrawalTransitions(): Array<readonly [PaystackWithdrawalState, PaystackWithdrawalState]> {
  return PAYSTACK_WITHDRAWAL_STATES.flatMap((from) => PAYSTACK_WITHDRAWAL_TRANSITIONS[from].map((to) => [from, to] as const));
}

export function withdrawalStatusOf(state: PaystackWithdrawalState): WithdrawalStatus {
  switch (state) {
    case PaystackWithdrawalState.RESERVED:
    case PaystackWithdrawalState.SUBMITTING:
    case PaystackWithdrawalState.PROCESSING:
      return 'PENDING';
    case PaystackWithdrawalState.POSTED:
      return 'COMPLETED';
    case PaystackWithdrawalState.FAILED:
      return 'FAILED';
    case PaystackWithdrawalState.REVERSED:
      return 'REVERSED';
  }
}
