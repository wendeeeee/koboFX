import { InvariantViolationError } from '../../../common/errors';

/** The funding state machine */
export enum FundingState {
  INITIATED = 'INITIATED',
  AUTHORIZED = 'AUTHORIZED',
  CAPTURED = 'CAPTURED',
  POSTED = 'POSTED',
  SETTLED = 'SETTLED',
  FAILED = 'FAILED',
  REVERSED = 'REVERSED',
}

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

export const FUNDING_TERMINAL_STATES: readonly FundingState[] = FUNDING_STATES.filter(
  (state) => FUNDING_TRANSITIONS[state].length === 0,
);

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

export function fundingTransitions(): Array<readonly [FundingState, FundingState]> {
  return FUNDING_STATES.flatMap((from) => FUNDING_TRANSITIONS[from].map((to) => [from, to] as const));
}

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

const RANK: Readonly<Record<FundingState, number>> = {
  [FundingState.INITIATED]: 0,
  [FundingState.AUTHORIZED]: 1,
  [FundingState.CAPTURED]: 2,
  [FundingState.POSTED]: 3,
  [FundingState.SETTLED]: 4,
  [FundingState.REVERSED]: 5,
  [FundingState.FAILED]: 5,
};

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
      return RANK[state] >= RANK[FundingState.POSTED];
    case 'payment.charged_back':
      return false;
    default:
      return true;
  }
}
