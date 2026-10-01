import { InvariantViolationError } from '../../../common/errors';
import { FundingStatus } from '../funding/funding-transitions';

/**
 * The Paystack funding state machine (PAYSTACK_PLAN.md C2). Paystack has no authorize/capture split: the customer
 * pays on Paystack's hosted checkout and `verify` says whether they did.
 *
 * - INITIATED — the worker initializes a checkout with reference = the flow id → CHECKOUT_READY. If an earlier
 *   initialize was accepted and its answer lost, the read-back (verify) decides: paid → POSTED (or HELD on a
 *   mismatch); otherwise → FAILED `CHECKOUT_UNRECOVERABLE` (Paystack never returns the URL again).
 * - CHECKOUT_READY — verify on backoff: paid with every field matching → POSTED; paid with another amount or
 *   currency → HELD (no credit); not paid and the window is over → FAILED.
 * - POSTED / SETTLED — a lost dispute → REVERSED. (SETTLED is unused until Paystack settlement ingestion exists.)
 * - HELD — no credit; a completion state. Reconciliation escalates the mismatch; an approved correction resolves it.
 *
 * The single source the SQL mirror (`flow_transition_allowed('PAYSTACK_FUNDING', …)`) is tested against.
 */
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

/** `completed_at` is set on entering these (the resumer has no more work); `HELD` waits for a human. */
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

/** The one wire status (Phase 8 decision 8): HELD reads PENDING — the money question is still open. */
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

/**
 * Has a flow in `state` already reached what a Paystack event hints at? Terminal states satisfy everything.
 * `charge.success` is satisfied once POSTED. A dispute being opened or reminded needs nothing until it is resolved;
 * `charge.dispute.resolve` makes a posted flow look at its disputes. Anything else (refunds, transfers…) only pokes.
 */
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
