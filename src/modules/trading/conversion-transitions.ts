import { InvariantViolationError } from '../../common/errors';


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
