import { ReservationStatus } from './reservation.types';

export enum ReservationCommand {
  SETTLE = 'SETTLE',
  RELEASE = 'RELEASE',
  EXPIRE = 'EXPIRE',
}

/**
 * What a command does to a reservation in a given state (design §6.5, "out-of-order
 * retries"). Always decided from the state read under the row lock, never from the
 * request.
 *
 * - `APPLY`: move to `to`; `releasesHold` says whether `reserved_minor` goes down.
 * - `NO_OP`: the goal already holds (e.g. release after anything: no hold remains).
 *   Succeed and return the reservation unchanged.
 * - `REPLAY`: settle after settle. Returns the original settlement if the actual
 *   matches; a different actual is a conflict (the caller compares).
 * - `REJECT`: settle after the flow released it.
 */
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
    // A late settlement: expiry is only the safety net, the money really moved. The
    // hold was already given back at expiry, so nothing more is released.
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

/** The status moves the database trigger allows — the transition table's `APPLY` edges. */
export function isLegalStatusMove(from: ReservationStatus, to: ReservationStatus): boolean {
  return Object.values(ReservationCommand).some((command) => {
    const decision = decideTransition(from, command);
    return decision.kind === 'APPLY' && decision.to === to;
  });
}
