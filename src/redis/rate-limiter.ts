import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

export interface RateLimitCounter {
  readonly key: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds until the tightest exceeded window resets; 0 when allowed. */
  readonly retryAfterSeconds: number;
}

/**
 * Fixed-window counters, all of one request's counters in ONE Lua script: increment,
 * start the window on the first hit, report count and remaining TTL. Redis runs a
 * script atomically, so concurrent requests can never both see "the 5th".
 */
const CONSUME_SCRIPT = `
local result = {}
for index, key in ipairs(KEYS) do
  local windowMilliseconds = tonumber(ARGV[index])
  local count = redis.call('INCR', key)
  local ttl = redis.call('PTTL', key)
  if count == 1 or ttl < 0 then
    redis.call('PEXPIRE', key, windowMilliseconds)
    ttl = windowMilliseconds
  end
  result[#result + 1] = count
  result[#result + 1] = ttl
end
return result
`;

@Injectable()
export class RateLimiter {
  constructor(private readonly redis: RedisService) {}

  /** Count one hit against every counter. Raises `DependencyUnavailableError` if Redis is down. */
  async consume(counters: readonly RateLimitCounter[]): Promise<RateLimitDecision> {
    if (counters.length === 0) return { allowed: true, retryAfterSeconds: 0 };
    const reply = (await this.redis.evaluate(
      CONSUME_SCRIPT,
      counters.map((counter) => counter.key),
      counters.map((counter) => counter.windowSeconds * 1000),
    )) as number[];
    let retryAfterMilliseconds = 0;
    counters.forEach((counter, index) => {
      const count = reply[index * 2];
      const ttl = reply[index * 2 + 1];
      if (count > counter.limit) retryAfterMilliseconds = Math.max(retryAfterMilliseconds, ttl);
    });
    return retryAfterMilliseconds > 0
      ? { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMilliseconds / 1000)) }
      : { allowed: true, retryAfterSeconds: 0 };
  }
}
