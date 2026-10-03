import { ReservationStatus } from './reservation.types';

export enum ReservationCommand {
  SETTLE = 'SETTLE',
  RELEASE = 'RELEASE',
  EXPIRE = 'EXPIRE',
}


export type TransitionDecision =
  | { readonly kind: 'APPLY'; readonly to: ReservationStatus; readonly releasesHold: boolean }
  | { readonly kind: 'NO_OP' }
  | { readonly kind: 'REPLAY' }
  | { readonly kind: 'REJECT' };

const APPLY = (to: ReservationStatus, releasesHold: boolean): TransitionDecision => ({ kind: 'APPLY', to, releasesHold });
const NO_OP: TransitionDecision = { kind: 'NO_OP' };

const TABLE: Readonly<Record<ReservationCommand, Readonly<Record<ReservationStatus, TransitionDecision>>>> = {
  [ReservationCommand.SETTLE]: {
    [ReservationStatus.ACTIVE]: APPLY(ReservationStatus.SETTLED, true),
    [ReservationStatus.EXPIRED]: APPLY(ReservationStatus.SETTLED, false),
    [ReservationStatus.SETTLED]: { kind: 'REPLAY' },
    [ReservationStatus.RELEASED]: { kind: 'REJECT' },
  },
  [ReservationCommand.RELEASE]: {
    [ReservationStatus.ACTIVE]: APPLY(ReservationStatus.RELEASED, true),
    [ReservationStatus.SETTLED]: NO_OP,
    [ReservationStatus.RELEASED]: NO_OP,
    [ReservationStatus.EXPIRED]: NO_OP,
  },
  [ReservationCommand.EXPIRE]: {
    [ReservationStatus.ACTIVE]: APPLY(ReservationStatus.EXPIRED, true),
    [ReservationStatus.SETTLED]: NO_OP,
    [ReservationStatus.RELEASED]: NO_OP,
    [ReservationStatus.EXPIRED]: NO_OP,
  },
};

export function decideTransition(status: ReservationStatus, command: ReservationCommand): TransitionDecision {
  return TABLE[command][status];
}

export function isLegalStatusMove(from: ReservationStatus, to: ReservationStatus): boolean {
  return Object.values(ReservationCommand).some((command) => {
    const decision = decideTransition(from, command);
    return decision.kind === 'APPLY' && decision.to === to;
  });
}
