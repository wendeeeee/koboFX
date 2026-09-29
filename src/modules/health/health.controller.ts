import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { Public, SkipRateLimit } from '../../common/decorators';
import { RedisService } from '../../redis/redis.service';
import { RateTier, ageSeconds } from '../fx/freshness';
import { FxRateService } from '../fx/fx-rate.service';

export type ComponentStatus = 'up' | 'down';

/**
 * Rate freshness (design §12), REPORTED but never failing readiness (Phase 6 §5.12): a
 * failing probe takes the whole instance out of the load balancer, and a cold or stale
 * rate must leave auth, wallet and history up (§16). FX age pages through
 * `fx_rate_age_seconds` instead.
 */
export interface FxReadiness {
  readonly tier: RateTier | 'NONE' | 'UNKNOWN';
  readonly rateAgeSeconds: number | null;
  readonly provider: string | null;
  readonly asOf: string | null;
}

export interface ReadinessReport {
  readonly status: 'ok' | 'unavailable';
  readonly checks: { readonly postgres: ComponentStatus; readonly redis: ComponentStatus };
  readonly fx: FxReadiness;
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
 * poll them. Rate freshness is reported (never failing); the build revision joins
 * readiness in its own phase.
 */
@Public()
@SkipRateLimit()
@Controller('health')
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly rates: FxRateService,
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
    return { status: healthy ? 'ok' : 'unavailable', checks: { postgres, redis }, fx: await this.fxReadiness() };
  }

  private async fxReadiness(): Promise<FxReadiness> {
    try {
      const served = await this.rates.current();
      if (!served) return { tier: 'NONE', rateAgeSeconds: null, provider: null, asOf: null };
      return {
        tier: served.freshness.tier,
        rateAgeSeconds: ageSeconds(served.freshness),
        provider: served.snapshot.provider,
        asOf: served.snapshot.providerUpdatedAt.toISOString(),
      };
    } catch {
      return { tier: 'UNKNOWN', rateAgeSeconds: null, provider: null, asOf: null };
    }
  }
}
