import { InvariantViolationError } from '../../../common/errors';
import { FundingStatus } from '../funding/funding-transitions';


export enum PaystackFundingState {
  INITIATED = 'INITIATED',
  CHECKOUT_READY = 'CHECKOUT_READY',
  POSTED = 'POSTED',
  SETTLED = 'SETTLED',
  FAILED = 'FAILED',
  REVERSED = 'REVERSED',
  HELD = 'HELD',
}

export const PAYSTACK_FUNDING_TRANSITIONS: Readonly<Record<PaystackFundingState, readonly PaystackFundingState[]>> = {
  [PaystackFundingState.INITIATED]: [
    PaystackFundingState.CHECKOUT_READY,
    PaystackFundingState.POSTED,
    PaystackFundingState.FAILED,
    PaystackFundingState.HELD,
  ],
  [PaystackFundingState.CHECKOUT_READY]: [PaystackFundingState.POSTED, PaystackFundingState.FAILED, PaystackFundingState.HELD],
  [PaystackFundingState.POSTED]: [PaystackFundingState.SETTLED, PaystackFundingState.REVERSED],
  [PaystackFundingState.SETTLED]: [PaystackFundingState.REVERSED],
  [PaystackFundingState.FAILED]: [],
  [PaystackFundingState.REVERSED]: [],
  [PaystackFundingState.HELD]: [],
};

export const PAYSTACK_FUNDING_STATES: readonly PaystackFundingState[] = Object.values(PaystackFundingState);

export const PAYSTACK_FUNDING_TERMINAL_STATES: readonly PaystackFundingState[] = PAYSTACK_FUNDING_STATES.filter(
  (state) => PAYSTACK_FUNDING_TRANSITIONS[state].length === 0,
);


export const PAYSTACK_FUNDING_COMPLETION_STATES: readonly PaystackFundingState[] = [
  PaystackFundingState.POSTED,
  PaystackFundingState.SETTLED,
  PaystackFundingState.FAILED,
  PaystackFundingState.REVERSED,
  PaystackFundingState.HELD,
];

export function isPaystackFundingState(value: string): value is PaystackFundingState {
  return (PAYSTACK_FUNDING_STATES as readonly string[]).includes(value);
}

export function assertPaystackTransition(from: PaystackFundingState, to: PaystackFundingState): void {
  if (!PAYSTACK_FUNDING_TRANSITIONS[from].includes(to)) {
    throw new InvariantViolationError(`A Paystack funding flow cannot move from ${from} to ${to}.`, { from, to });
  }
}

export function paystackFundingTransitions(): Array<readonly [PaystackFundingState, PaystackFundingState]> {
  return PAYSTACK_FUNDING_STATES.flatMap((from) => PAYSTACK_FUNDING_TRANSITIONS[from].map((to) => [from, to] as const));
}

export function paystackFundingStatusOf(state: PaystackFundingState): FundingStatus {
  switch (state) {
    case PaystackFundingState.INITIATED:
    case PaystackFundingState.CHECKOUT_READY:
    case PaystackFundingState.HELD:
      return 'PENDING';
    case PaystackFundingState.POSTED:
    case PaystackFundingState.SETTLED:
      return 'COMPLETED';
    case PaystackFundingState.FAILED:
      return 'FAILED';
    case PaystackFundingState.REVERSED:
      return 'REVERSED';
  }
}

const RANK: Readonly<Record<PaystackFundingState, number>> = {
  [PaystackFundingState.INITIATED]: 0,
  [PaystackFundingState.CHECKOUT_READY]: 1,
  [PaystackFundingState.POSTED]: 2,
  [PaystackFundingState.SETTLED]: 3,
  [PaystackFundingState.REVERSED]: 4,
  [PaystackFundingState.FAILED]: 4,
  [PaystackFundingState.HELD]: 4,
};

export function isPaystackHintSatisfied(state: PaystackFundingState, eventType: string): boolean {
  if (PAYSTACK_FUNDING_TERMINAL_STATES.includes(state)) return true;
  switch (eventType) {
    case 'charge.success':
      return RANK[state] >= RANK[PaystackFundingState.POSTED];
    case 'charge.dispute.resolve':
      return RANK[state] < RANK[PaystackFundingState.POSTED];
    default:
      return true;
  }
}
