import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { Public, SkipRateLimit } from '../../common/decorators';
import { RedisService } from '../../redis/redis.service';

export type ComponentStatus = 'up' | 'down';

export interface ReadinessReport {
  readonly status: 'ok' | 'unavailable';
  readonly checks: { readonly postgres: ComponentStatus; readonly redis: ComponentStatus };
}

const CHECK_TIMEOUT_MILLISECONDS = 1500;

async function probe(check: () => Promise<unknown>): Promise<ComponentStatus> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MILLISECONDS);
  });
  try {
    await Promise.race([check(), timeout]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Liveness and readiness (design §12, §16). Public and never rate-limited: probes
 * poll them. Rate freshness and the git SHA join readiness in their own phases.
 */
@Public()
@SkipRateLimit()
@Controller('health')
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessReport> {
    const [postgres, redis] = await Promise.all([
      probe(() => this.dataSource.query('SELECT 1')),
      probe(() => this.redis.ping()),
    ]);
    const healthy = postgres === 'up' && redis === 'up';
    response.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: healthy ? 'ok' : 'unavailable', checks: { postgres, redis } };
  }
}
