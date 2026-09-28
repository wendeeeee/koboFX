import { randomUUID } from 'node:crypto';
import { InvariantViolationError } from '../../common/errors';
import { userIdOf } from '../notifications/outbox-handlers';
import { backoffSeconds } from './outbox-dispatcher';
import { OutboxEventType } from './outbox.types';

describe('outbox', () => {
  it('backs off exponentially from 5s, capped at an hour', () => {
    expect([1, 2, 3, 4, 10, 20].map(backoffSeconds)).toEqual([5, 10, 20, 40, 2560, 3600]);
  });

  it('handlers refuse payloads that do not match their aggregate (never trust the shape)', () => {
    const userId = randomUUID();
    const event = (payload: unknown, aggregateId = userId) => ({
      id: randomUUID(),
      eventType: OutboxEventType.EMAIL_VERIFICATION_REQUESTED,
      aggregateId,
      payload,
      attempts: 1,
    });
    expect(userIdOf(event({ userId }))).toBe(userId);
    for (const bad of [null, {}, { userId: 'x' }, { userId: 42 }]) {
      expect(() => userIdOf(event(bad))).toThrow(InvariantViolationError);
    }
    expect(() => userIdOf(event({ userId }, randomUUID()))).toThrow(InvariantViolationError);
  });
});
