import { Global, Module, OnApplicationBootstrap } from '@nestjs/common';
import { RateLimiter } from './rate-limiter';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService, RateLimiter],
  exports: [RedisService, RateLimiter],
})
export class RedisModule implements OnApplicationBootstrap {
  constructor(private readonly redis: RedisService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.redis.waitUntilReady(3000);
  }
}
