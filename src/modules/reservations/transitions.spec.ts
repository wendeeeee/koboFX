import { ReservationStatus } from './reservation.types';
import { ReservationCommand, decideTransition, isLegalStatusMove } from './transitions';

const { ACTIVE, SETTLED, RELEASED, EXPIRED } = ReservationStatus;
const { SETTLE, RELEASE, EXPIRE } = ReservationCommand;

describe('reservation transition table (design §6.3, §6.5)', () => {
  it.each([
    [ACTIVE, SETTLE, { kind: 'APPLY', to: SETTLED, releasesHold: true }],
    [EXPIRED, SETTLE, { kind: 'APPLY', to: SETTLED, releasesHold: false }],
    [SETTLED, SETTLE, { kind: 'REPLAY' }],
    [RELEASED, SETTLE, { kind: 'REJECT' }],
    [ACTIVE, RELEASE, { kind: 'APPLY', to: RELEASED, releasesHold: true }],
    [SETTLED, RELEASE, { kind: 'NO_OP' }],
    [RELEASED, RELEASE, { kind: 'NO_OP' }],
    [EXPIRED, RELEASE, { kind: 'NO_OP' }],
    [ACTIVE, EXPIRE, { kind: 'APPLY', to: EXPIRED, releasesHold: true }],
    [SETTLED, EXPIRE, { kind: 'NO_OP' }],
    [RELEASED, EXPIRE, { kind: 'NO_OP' }],
    [EXPIRED, EXPIRE, { kind: 'NO_OP' }],
  ])('%s + %s → %o', (status, command, expected) => {
    expect(decideTransition(status, command)).toEqual(expected);
  });

  it('releases a hold at most once over any path: only moves out of ACTIVE release it', () => {
    for (const status of Object.values(ReservationStatus)) {
      for (const command of Object.values(ReservationCommand)) {
        const decision = decideTransition(status, command);
        if (decision.kind === 'APPLY' && decision.releasesHold) expect(status).toBe(ACTIVE);
      }
    }
  });

  it('allows exactly the status moves the database trigger allows', () => {
    const legal = Object.values(ReservationStatus).flatMap((from) =>
      Object.values(ReservationStatus)
        .filter((to) => isLegalStatusMove(from, to))
        .map((to) => `${from}→${to}`),
    );
    expect(legal.sort()).toEqual(['ACTIVE→EXPIRED', 'ACTIVE→RELEASED', 'ACTIVE→SETTLED', 'EXPIRED→SETTLED']);
  });
});
