import { Inject, Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { DependencyUnavailableError } from '../../common/errors';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { ExchangeRateSnapshotRepository, RateSnapshot } from './exchange-rate-snapshot.repository';
import { FetchCoordination } from './fetch-coordination';
import { Freshness, FreshnessPolicy, RateTier, freshnessOf } from './freshness';
import { FxRateFetcher } from './fx-rate-fetcher';
import { FxRateStaleError, FxRateUnavailableError } from './fx.errors';
import { RateCache } from './rate-cache';

export interface ServedSnapshot {
  readonly snapshot: RateSnapshot;
  readonly freshness: Freshness;
  readonly source: 'MEMORY' | 'REDIS' | 'DATABASE';
}

export const CATCH_UP_WAIT_MILLISECONDS = 2_500;
const CATCH_UP_POLL_MILLISECONDS = 100;

@Injectable()
export class FxRateService {
  private readonly logger = new Logger(FxRateService.name);
  private local: { snapshot: RateSnapshot; source: 'REDIS' | 'DATABASE'; readAt: number } | undefined;
  private inflight: Promise<{ snapshot: RateSnapshot; source: ServedSnapshot['source'] } | undefined> | undefined;

  constructor(
    private readonly cache: RateCache,
    private readonly snapshots: ExchangeRateSnapshotRepository,
    private readonly fetcher: FxRateFetcher,
    private readonly coordination: FetchCoordination,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get policy(): FreshnessPolicy {
    const fx = this.config.fx;
    return {
      executableMaximumAgeSeconds: fx.executableMaximumAgeSeconds,
      displayMaximumAgeSeconds: fx.displayMaximumAgeSeconds,
      publicationGraceSeconds: fx.publicationGraceSeconds,
    };
  }

  get providerName(): string {
    return this.config.fx.providerName;
  }

  async current(): Promise<ServedSnapshot | undefined> {
    const read = await this.read();
    if (!read) return undefined;
    return { snapshot: read.snapshot, source: read.source, freshness: freshnessOf(read.snapshot, this.clock.now(), this.policy) };
  }

  async displayable(): Promise<ServedSnapshot> {
    let served = await this.current();
    if (!served || served.freshness.tier === RateTier.UNSERVABLE) served = await this.catchUp(served, RateTier.DISPLAY_ONLY);
    if (!served || served.freshness.tier === RateTier.UNSERVABLE) {
      throw new FxRateUnavailableError(served ? { asOf: served.snapshot.providerUpdatedAt.toISOString() } : undefined);
    }
    return served;
  }

  async prepareExecutable(): Promise<ServedSnapshot | undefined> {
    try {
      const served = await this.current();
      if (served?.freshness.tier === RateTier.EXECUTABLE) return served;
      return (await this.catchUp(served, RateTier.EXECUTABLE)) ?? served;
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not prepare an FX snapshot');
      return undefined;
    }
  }

  requireExecutable(prepared: ServedSnapshot | undefined): ServedSnapshot {
    if (!prepared) throw new FxRateUnavailableError();
    const freshness = freshnessOf(prepared.snapshot, this.clock.now(), this.policy);
    if (freshness.tier !== RateTier.EXECUTABLE) {
      throw new FxRateStaleError({
        asOf: prepared.snapshot.providerUpdatedAt.toISOString(),
        rateAgeSeconds: Math.ceil(freshness.ageMilliseconds / 1000),
        executableMaximumAgeSeconds: this.config.fx.executableMaximumAgeSeconds,
      });
    }
    return { ...prepared, freshness };
  }

  forgetLocalCopy(): void {
    this.local = undefined;
  }

  private read(): Promise<{ snapshot: RateSnapshot; source: ServedSnapshot['source'] } | undefined> {
    const local = this.local;
    if (local && Date.now() - local.readAt < this.config.fx.localCacheMilliseconds) {
      return Promise.resolve({ snapshot: local.snapshot, source: 'MEMORY' });
    }
    this.inflight ??= this.readThrough().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async readThrough(): Promise<{ snapshot: RateSnapshot; source: ServedSnapshot['source'] } | undefined> {
    let snapshot: RateSnapshot | undefined;
    let source: 'REDIS' | 'DATABASE' = 'REDIS';
    try {
      snapshot = await this.cache.read();
    } catch (error) {
      if (!(error instanceof DependencyUnavailableError)) throw error;
    }
    if (!snapshot) {
      source = 'DATABASE';
      snapshot = await this.snapshots.latestServable(this.providerName);
    }
    if (!snapshot) return undefined;
    this.local = { snapshot, source, readAt: Date.now() };
    return { snapshot, source };
  }

  private async catchUp(before: ServedSnapshot | undefined, wanted: RateTier.EXECUTABLE | RateTier.DISPLAY_ONLY): Promise<ServedSnapshot | undefined> {
    const good = (served: ServedSnapshot | undefined) =>
      served !== undefined && (served.freshness.tier === RateTier.EXECUTABLE || (wanted === RateTier.DISPLAY_ONLY && served.freshness.tier === RateTier.DISPLAY_ONLY));
    try {
      const start = await this.coordination.beginCatchUp();
      if (start.kind === 'GATED') return this.current();
      if (start.kind === 'STARTED') {
        const outcome = await this.fetcher.fetch('CATCH_UP', start.lockToken);
        this.local = undefined;
        if (outcome.kind === 'ACCEPTED') {
          return { snapshot: outcome.snapshot, source: 'REDIS', freshness: freshnessOf(outcome.snapshot, this.clock.now(), this.policy) };
        }
        return this.current();
      }
      const deadline = Date.now() + CATCH_UP_WAIT_MILLISECONDS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, CATCH_UP_POLL_MILLISECONDS));
        this.local = undefined;
        const served = await this.current();
        const newer = served !== undefined && (!before || served.snapshot.id !== before.snapshot.id);
        if (newer && good(served)) return served;
        if (!(await this.coordination.isFetchInProgress())) return served;
      }
      return this.current();
    } catch (error) {
      if (error instanceof DependencyUnavailableError) return before;
      throw error;
    }
  }
}
