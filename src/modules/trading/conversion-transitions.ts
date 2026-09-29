import { InvariantViolationError } from '../../common/errors';

/**
 * The conversion flow (Phase 7, handbook Flow 3 steps 1 and 5): a conversion creates its
 * flow, reserves, settles and completes it inside ONE transaction, so `INITIATED` is never
 * committed and the resumer never sees a conversion. The flow row exists to own the hold
 * (`reservations.flow_id`). The SQL mirror is `flow_transition_allowed('CONVERSION', …)`,
 * tested equal.
 */
export enum ConversionState {
  INITIATED = 'INITIATED',
  POSTED = 'POSTED',
}

export const CONVERSION_TRANSITIONS: Readonly<Record<ConversionState, readonly ConversionState[]>> = {
  [ConversionState.INITIATED]: [ConversionState.POSTED],
  [ConversionState.POSTED]: [],
};

export const CONVERSION_STATES: readonly ConversionState[] = Object.values(ConversionState);

export function canTransitionConversion(from: ConversionState, to: ConversionState): boolean {
  return CONVERSION_TRANSITIONS[from].includes(to);
}

export function assertConversionTransition(from: ConversionState, to: ConversionState): void {
  if (!canTransitionConversion(from, to)) {
    throw new InvariantViolationError(`A conversion flow cannot move from ${from} to ${to}.`, { from, to });
  }
}
