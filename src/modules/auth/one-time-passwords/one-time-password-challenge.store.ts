import { Injectable } from '@nestjs/common';
import { RedisService } from '../../../redis/redis.service';
import { OneTimePasswordPurpose } from './one-time-password';

export type ChallengeAttempt =
  | { readonly kind: 'GONE' }
  | {
      readonly kind: 'EVALUATE';
      readonly challengeId: string;
      readonly hmac: Buffer;
      readonly attempt: number;
      /** This was the last permitted attempt: the challenge is already deleted. */
      readonly lastAttempt: boolean;
    };

/** Replace any challenge with a fresh one, attempts at zero, with its TTL — atomically. */
const STORE_SCRIPT = `
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'challengeId', ARGV[1], 'hmac', ARGV[2], 'attempts', 0)
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`;

/**
 * Count one attempt and hand back what to compare against — atomically. The attempt
 * that reaches the maximum deletes the challenge in the same step, so however many
 * guesses arrive at once, at most the maximum are ever evaluated.
 */
const ATTEMPT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'GONE'} end
local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
local fields = redis.call('HMGET', KEYS[1], 'challengeId', 'hmac')
local last = '0'
if attempts >= tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1])
  last = '1'
end
return {'EVALUATE', fields[1], fields[2], tostring(attempts), last}
`;

/** Single use: delete only if the challenge is still the one that matched. One caller wins. */
const CONSUME_SCRIPT = `
if redis.call('HGET', KEYS[1], 'challengeId') == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

/**
 * One-time password challenges in Redis (design §7.1): ephemeral, TTL-expiring, and
 * never the code itself — only its HMAC. Every operation is one Lua script, so the
 * attempt counter and single use are atomic. Redis down ⇒ `DependencyUnavailableError`
 * ⇒ verification fails closed (503), never a bypass.
 */
@Injectable()
export class OneTimePasswordChallengeStore {
  constructor(private readonly redis: RedisService) {}

  static key(purpose: OneTimePasswordPurpose, userId: string): string {
    return `one-time-password:email:${purpose}:${userId}`;
  }

  async store(
    purpose: OneTimePasswordPurpose,
    userId: string,
    challengeId: string,
    hmac: Buffer,
    timeToLiveSeconds: number,
  ): Promise<void> {
    await this.redis.evaluate(
      STORE_SCRIPT,
      [OneTimePasswordChallengeStore.key(purpose, userId)],
      [challengeId, hmac.toString('hex'), timeToLiveSeconds * 1000],
    );
  }

  async attempt(purpose: OneTimePasswordPurpose, userId: string, maximumAttempts: number): Promise<ChallengeAttempt> {
    const reply = (await this.redis.evaluate(
      ATTEMPT_SCRIPT,
      [OneTimePasswordChallengeStore.key(purpose, userId)],
      [maximumAttempts],
    )) as string[];
    if (reply[0] !== 'EVALUATE') return { kind: 'GONE' };
    return {
      kind: 'EVALUATE',
      challengeId: reply[1],
      hmac: Buffer.from(reply[2], 'hex'),
      attempt: Number(reply[3]),
      lastAttempt: reply[4] === '1',
    };
  }

  async consume(purpose: OneTimePasswordPurpose, userId: string, challengeId: string): Promise<boolean> {
    const reply = await this.redis.evaluate(
      CONSUME_SCRIPT,
      [OneTimePasswordChallengeStore.key(purpose, userId)],
      [challengeId],
    );
    return reply === 1;
  }
}
