import { InvariantViolationError } from '../../../common/errors';

/** The funding state machine (design §7.5; handbook Appendix B, Flow 2). */
export enum FundingState {
  INITIATED = 'INITIATED',
  AUTHORIZED = 'AUTHORIZED',
  CAPTURED = 'CAPTURED',
  POSTED = 'POSTED',
  SETTLED = 'SETTLED',
  FAILED = 'FAILED',
  REVERSED = 'REVERSED',
}

/**
 * The transition table — pure, and the single source the SQL mirror
 * (`flow_transition_allowed`) is tested against. Deltas vs the §7.5 diagram (approved):
 * `SETTLED → REVERSED` (chargebacks usually arrive after settlement). `POSTED → SETTLED`
 * is legal but executed only by Phase 9.
 */
export const FUNDING_TRANSITIONS: Readonly<Record<FundingState, readonly FundingState[]>> = {
  [FundingState.INITIATED]: [FundingState.AUTHORIZED, FundingState.FAILED],
  [FundingState.AUTHORIZED]: [FundingState.CAPTURED, FundingState.FAILED],
  [FundingState.CAPTURED]: [FundingState.POSTED],
  [FundingState.POSTED]: [FundingState.SETTLED, FundingState.REVERSED],
  [FundingState.SETTLED]: [FundingState.REVERSED],
  [FundingState.FAILED]: [],
  [FundingState.REVERSED]: [],
};

export const FUNDING_STATES: readonly FundingState[] = Object.values(FundingState);

/** No transition leaves these. */
export const FUNDING_TERMINAL_STATES: readonly FundingState[] = FUNDING_STATES.filter(
  (state) => FUNDING_TRANSITIONS[state].length === 0,
);

/** `completed_at` is set on entering these: the resumer has no more work (Phase 5 stops at POSTED). */
export const FUNDING_COMPLETION_STATES: readonly FundingState[] = [
  FundingState.POSTED,
  FundingState.SETTLED,
  FundingState.FAILED,
  FundingState.REVERSED,
];

export function isFundingState(value: string): value is FundingState {
  return (FUNDING_STATES as readonly string[]).includes(value);
}

export function canTransition(from: FundingState, to: FundingState): boolean {
  return FUNDING_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: FundingState, to: FundingState): void {
  if (!canTransition(from, to)) {
    throw new InvariantViolationError(`A funding flow cannot move from ${from} to ${to}.`, { from, to });
  }
}

/** Every legal (from, to) pair — what crash injection enumerates. */
export function fundingTransitions(): Array<readonly [FundingState, FundingState]> {
  return FUNDING_STATES.flatMap((from) => FUNDING_TRANSITIONS[from].map((to) => [from, to] as const));
}

/** What a client sees (design §12: `POST /wallet/fund` returns `PENDING`). */
export type FundingStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERSED';

export function fundingStatusOf(state: FundingState): FundingStatus {
  switch (state) {
    case FundingState.INITIATED:
    case FundingState.AUTHORIZED:
    case FundingState.CAPTURED:
      return 'PENDING';
    case FundingState.POSTED:
    case FundingState.SETTLED:
      return 'COMPLETED';
    case FundingState.FAILED:
      return 'FAILED';
    case FundingState.REVERSED:
      return 'REVERSED';
  }
}

/** Progress along the happy path, for "has the flow got at least this far". */
const RANK: Readonly<Record<FundingState, number>> = {
  [FundingState.INITIATED]: 0,
  [FundingState.AUTHORIZED]: 1,
  [FundingState.CAPTURED]: 2,
  [FundingState.POSTED]: 3,
  [FundingState.SETTLED]: 4,
  [FundingState.REVERSED]: 5,
  [FundingState.FAILED]: 5,
};

/**
 * Has a flow in `state` already reached what a webhook of `eventType` hints at? A hint
 * is satisfied by any state at or beyond it, and by any terminal state (nothing more
 * will happen). Unknown event types are satisfied by any state: they only poke.
 */
export function isFundingHintSatisfied(state: FundingState, eventType: string): boolean {
  if (FUNDING_TERMINAL_STATES.includes(state)) return true;
  switch (eventType) {
    case 'payment.authorized':
      return RANK[state] >= RANK[FundingState.AUTHORIZED];
    case 'payment.capture_pending':
      return RANK[state] >= RANK[FundingState.AUTHORIZED];
    case 'payment.captured':
      return RANK[state] >= RANK[FundingState.POSTED];
    case 'payment.declined':
    case 'payment.expired':
    case 'payment.voided':
    case 'payment.capture_failed':
      // Only a terminal state satisfies a failure hint (handled above); a stale failure
      // for a payment that went on to be captured is satisfied by completion.
      return RANK[state] >= RANK[FundingState.POSTED];
    case 'payment.charged_back':
      return false;
    default:
      return true;
  }
}
