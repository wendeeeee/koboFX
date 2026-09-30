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

/** A snapshot with its tier, as of one clock reading. */
export interface ServedSnapshot {
  readonly snapshot: RateSnapshot;
  readonly freshness: Freshness;
  /** Where it came from — for tests and logs. */
  readonly source: 'MEMORY' | 'REDIS' | 'DATABASE';
}

/** How long a loser of the single flight waits for the winner's snapshot. */
export const CATCH_UP_WAIT_MILLISECONDS = 2_500;
const CATCH_UP_POLL_MILLISECONDS = 100;

/**
 * The rate read path (design §7.4; Phase 6 §D, §5.15):
 *
 * 1. a per-process copy, at most `FX_LOCAL_CACHE_MILLISECONDS` old (so it can lag Redis by
 *    at most that; when Redis is down it bounds database reads to one per interval);
 * 2. Redis `fx:snapshot:USD`;
 * 3. the latest ACCEPTED database snapshot (Redis empty, flushed or down — §16);
 * 4. only when nothing displayable exists (or, for execution, nothing executable): ONE
 *    single-flighted synchronous catch-up — at most one per minute globally, inside the
 *    request budget and the breaker, a single 2s attempt — whose losers wait for the
 *    winner's snapshot;
 * 5. `503 FX_RATE_UNAVAILABLE` (or `FX_RATE_STALE` for execution).
 *
 * Request handlers never write Redis and never call the provider themselves: provider
 * volume is set by the poll schedule and the budget, never by user traffic.
 */
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

  /** The newest snapshot we hold, with its tier (may be UNSERVABLE), without any provider call. */
  async current(): Promise<ServedSnapshot | undefined> {
    const read = await this.read();
    if (!read) return undefined;
    return { snapshot: read.snapshot, source: read.source, freshness: freshnessOf(read.snapshot, this.clock.now(), this.policy) };
  }

  /** For display: DISPLAY_ONLY or better, catching up once if nothing is displayable; else 503. */
  async displayable(): Promise<ServedSnapshot> {
    let served = await this.current();
    if (!served || served.freshness.tier === RateTier.UNSERVABLE) served = await this.catchUp(served, RateTier.DISPLAY_ONLY);
    if (!served || served.freshness.tier === RateTier.UNSERVABLE) {
      throw new FxRateUnavailableError(served ? { asOf: served.snapshot.providerUpdatedAt.toISOString() } : undefined);
    }
    return served;
  }

  /**
   * Prepare a snapshot for execution OUTSIDE any transaction (the pre-barrier guard,
   * Phase 6 §5.7): if what we hold is not executable, try one bounded catch-up. Never
   * throws — the handler decides, inside the barrier, with `requireExecutable`.
   */
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

  /**
   * The execution decision, re-evaluated on the clock at the moment of use (a snapshot
   * prepared a moment ago may have aged out since). Throws `503 FX_RATE_STALE` +
   * `Retry-After`, or `503 FX_RATE_UNAVAILABLE` when there is nothing at all.
   */
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

  /** Drop the per-process copy (tests; the poller after writing). */
  forgetLocalCopy(): void {
    this.local = undefined;
  }

  private read(): Promise<{ snapshot: RateSnapshot; source: ServedSnapshot['source'] } | undefined> {
    const local = this.local;
    if (local && Date.now() - local.readAt < this.config.fx.localCacheMilliseconds) {
      return Promise.resolve({ snapshot: local.snapshot, source: 'MEMORY' });
    }
    // Concurrent readers in this process share one read: a burst never becomes a burst of
    // Redis (or, with Redis down, database) queries.
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
      // LOCKED: someone else is fetching — wait briefly for their snapshot.
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
