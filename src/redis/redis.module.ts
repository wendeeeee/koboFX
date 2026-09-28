import { Global, Module, OnApplicationBootstrap } from '@nestjs/common';
import { RateLimiter } from './rate-limiter';
import { RedisService } from './redis.service';

/** Global: rate limiting and one-time passwords both need it. */
@Global()
@Module({
  providers: [RedisService, RateLimiter],
  exports: [RedisService, RateLimiter],
})
export class RedisModule implements OnApplicationBootstrap {
  constructor(private readonly redis: RedisService) {}

  /**
   * Give Redis a moment to connect so the first requests don't fail spuriously. Boot
   * proceeds either way: a Redis outage is reported by /health/ready, and the routes
   * that need Redis fail closed on their own.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.redis.waitUntilReady(3000);
  }
}
