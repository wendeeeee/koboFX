import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { DependencyUnavailableError } from '../common/errors';
import { APP_CONFIG } from '../config/config.module';
import { AppConfig } from '../config/configuration';

const COMMAND_TIMEOUT_MILLISECONDS = 1000;


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
      retryStrategy: (attempt) => Math.min(attempt * 100, 2000),
    });
    this.client.on('error', (error: Error) => this.logger.warn({ reason: error.message }, 'Redis connection error'));
  }

  async evaluate(script: string, keys: readonly string[], args: readonly (string | number)[]): Promise<unknown> {
    return this.command(() => this.client.eval(script, keys.length, ...keys, ...args));
  }

  async ping(): Promise<void> {
    await this.command(() => this.client.ping());
  }

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
