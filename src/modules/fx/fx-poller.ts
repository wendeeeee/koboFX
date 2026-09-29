import { Inject, Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { DependencyUnavailableError } from '../../common/errors';
import { PollingLoop } from '../../common/polling/polling-loop';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { ExchangeRateSnapshotRepository } from './exchange-rate-snapshot.repository';
import { FetchOutcome, FxRateFetcher } from './fx-rate-fetcher';
import { snapshotOrder } from './rate-cache';
import { RateCache } from './rate-cache';
import { isPollDue } from './poll-schedule';
import { PROVIDER_PLAN_PROFILES } from './provider-plan';

export type PollTickResult =
  | { readonly fetched: false; readonly reseeded: boolean }
  | { readonly fetched: true; readonly reseeded: boolean; readonly outcome: FetchOutcome };

/**
 * The worker's FX poller (design §7.4, §14 `fx-poller.ts`; Phase 6 §5.3). Every
 * `FX_POLL_INTERVAL_MILLISECONDS` it:
 *
 * 1. re-seeds Redis from the latest ACCEPTED database snapshot when Redis is empty,
 *    flushed or older (request handlers never write the cache);
 * 2. asks the pure schedule whether a new publication can exist yet (just after the
 *    provider's announced `time_next_update`, with jitter; the late-provider retry), and
 *    only then fetches — through the fetcher's lock, breaker and budget, so two workers
 *    running at once still make one call and never interleave a snapshot.
 *
 * Quota-aware by construction: the schedule never fetches faster than the provider
 * publishes, and the budget caps every attempt.
 */
@Injectable()
export class FxPoller {
  private readonly logger = new Logger(FxPoller.name);
  private readonly loop: PollingLoop;

  constructor(
    private readonly fetcher: FxRateFetcher,
    private readonly snapshots: ExchangeRateSnapshotRepository,
    private readonly cache: RateCache,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.loop = new PollingLoop(
      FxPoller.name,
      async () => {
        await this.tick();
        return { fullBatch: false };
      },
      () => config.fx.pollIntervalMilliseconds,
    );
  }

  async tick(): Promise<PollTickResult> {
    const fx = this.config.fx;
    const reseeded = await this.reseedCache();
    const latest = await this.snapshots.latestFetch(fx.providerName);
    const profile = {
      ...PROVIDER_PLAN_PROFILES[fx.plan],
      publicationGraceSeconds: fx.publicationGraceSeconds,
      latePublicationRetrySeconds: fx.latePublicationRetrySeconds,
    };
    const due = isPollDue(
      this.clock.now(),
      latest && { snapshotId: latest.id, fetchedAt: latest.fetchedAt, providerUpdatedAt: latest.providerUpdatedAt, providerNextUpdateAt: latest.providerNextUpdateAt },
      profile,
    );
    if (!due) return { fetched: false, reseeded };
    const outcome = await this.fetcher.fetch('POLL');
    return { fetched: true, reseeded, outcome };
  }

  /** Put the latest accepted snapshot back into Redis if Redis lost it or holds an older one. */
  private async reseedCache(): Promise<boolean> {
    const latest = await this.snapshots.latestAccepted(this.config.fx.providerName);
    if (!latest) return false;
    try {
      const cached = await this.cache.read();
      if (cached && snapshotOrder(cached) >= snapshotOrder(latest)) return false;
      const written = await this.cache.offer(latest, this.fetcher.cacheTimeToLiveSeconds);
      if (written) this.logger.log({ snapshotId: latest.id }, 'Re-seeded the FX rate cache from the database');
      return written;
    } catch (error) {
      if (error instanceof DependencyUnavailableError) return false;
      throw error;
    }
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }
}
