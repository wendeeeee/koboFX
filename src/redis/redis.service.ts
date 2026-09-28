import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { DependencyUnavailableError } from '../common/errors';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/configuration';

/** Budget for one Redis command. Redis answers in microseconds; anything slower is an outage. */
const COMMAND_TIMEOUT_MILLISECONDS = 1000;

/**
 * The one door to Redis (design §7.1, §9.1, §16). Redis holds only ephemeral state —
 * one-time password challenges and rate-limit counters — never anything durable.
 *
 * Fail fast: no offline queue, one attempt per command, a short timeout. When Redis
 * is down every command raises `DependencyUnavailableError` (503) immediately, and
 * each caller decides explicitly whether that means fail closed or fail open.
 * Nothing waits, and nothing silently succeeds.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = new Redis(config.redisUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      commandTimeout: COMMAND_TIMEOUT_MILLISECONDS,
      connectTimeout: 2000,
      // Keep trying to reconnect in the background, backing off to 2s.
      retryStrategy: (attempt) => Math.min(attempt * 100, 2000),
    });
    // Without a listener ioredis reports connection errors as unhandled.
    this.client.on('error', (error: Error) => this.logger.warn({ reason: error.message }, 'Redis connection error'));
  }

  /** Run a Lua script atomically. Redis executes one script at a time: that IS the atomicity. */
  async evaluate(script: string, keys: readonly string[], args: readonly (string | number)[]): Promise<unknown> {
    return this.command(() => this.client.eval(script, keys.length, ...keys, ...args));
  }

  async ping(): Promise<void> {
    await this.command(() => this.client.ping());
  }

  /** Resolves once connected, or after `timeoutMilliseconds` — boot must not hang on Redis. */
  async waitUntilReady(timeoutMilliseconds: number): Promise<boolean> {
    if (this.client.status === 'ready') return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.client.off('ready', onReady);
        resolve(false);
      }, timeoutMilliseconds);
      const onReady = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.client.once('ready', onReady);
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }

  private async command<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw new DependencyUnavailableError(
        'A required service is temporarily unavailable. Retry shortly.',
        { dependency: 'redis' },
        { cause: error },
      );
    }
  }
}
