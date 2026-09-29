import { Inject, Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { DependencyUnavailableError } from '../../common/errors';
import { Dec, dec } from '../../common/money';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { CurrencyRegistry } from '../currencies/currency-registry';
import { ExchangeRateSnapshotRepository, RateSnapshot, SnapshotStatus } from './exchange-rate-snapshot.repository';
import { FetchCoordination } from './fetch-coordination';
import { FxMetrics } from './fx-metrics';
import { FetchFailureKind, pages } from './poll-schedule';
import { RateProvider } from './providers/rate-provider.port';
import { RateCache } from './rate-cache';
import { checkSanity } from './rate-sanity';

export type FetchTrigger = 'POLL' | 'CATCH_UP';

export type FetchOutcome =
  | { readonly kind: 'ACCEPTED'; readonly snapshot: RateSnapshot }
  | { readonly kind: 'REJECTED'; readonly snapshotId: string; readonly reasons: readonly string[] }
  | { readonly kind: 'FAILED'; readonly failure: FetchFailureKind; readonly detail: string }
  | { readonly kind: 'SKIPPED'; readonly reason: 'LOCKED' | 'BACKING_OFF' | 'REDIS_UNAVAILABLE' };

/**
 * The rate pipeline (design §7.4; Phase 6 §D): lock → breaker → budget → fetch →
 * validate → sanity → store → cache. Used by the poller and by the single-flighted
 * catch-up; nothing else ever calls the provider.
 *
 * - No database transaction is open during the provider call; the snapshot insert is
 *   its own short transaction afterwards.
 * - A response that fails sanity is stored REJECTED (evidence) and alerted, never cached
 *   or served; the last accepted snapshot keeps ageing honestly.
 * - A failure writes nothing but the `provider_calls` evidence, and opens the breaker for
 *   the failure kind's backoff; the kinds that will not heal on their own page.
 * - Without Redis there is no lock and no budget, so there is no call (fail closed on the
 *   quota): rates are then served from the database snapshot (§16).
 */
@Injectable()
export class FxRateFetcher {
  private readonly logger = new Logger(FxRateFetcher.name);

  constructor(
    private readonly provider: RateProvider,
    private readonly snapshots: ExchangeRateSnapshotRepository,
    private readonly cache: RateCache,
    private readonly coordination: FetchCoordination,
    private readonly currencies: CurrencyRegistry,
    private readonly metrics: FxMetrics,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get cacheTimeToLiveSeconds(): number {
    return this.config.fx.displayMaximumAgeSeconds + 3_600;
  }

  /** `heldLockToken`: the catch-up took the fetch lock atomically with its gate. */
  async fetch(trigger: FetchTrigger, heldLockToken?: string): Promise<FetchOutcome> {
    let token: string | undefined = heldLockToken;
    try {
      token ??= await this.coordination.acquireFetchLock();
      if (!token) return { kind: 'SKIPPED', reason: 'LOCKED' };
      const backoff = await this.coordination.backoff();
      if (backoff) return { kind: 'SKIPPED', reason: 'BACKING_OFF' };
      return await this.fetchHoldingLock(trigger);
    } catch (error) {
      if (error instanceof DependencyUnavailableError) {
        this.logger.warn({ trigger }, 'Redis unavailable: no FX provider call (the budget and lock cannot be enforced)');
        return { kind: 'SKIPPED', reason: 'REDIS_UNAVAILABLE' };
      }
      throw error;
    } finally {
      if (token) await this.coordination.releaseFetchLock(token).catch(() => undefined);
    }
  }

  private async fetchHoldingLock(trigger: FetchTrigger): Promise<FetchOutcome> {
    const fx = this.config.fx;
    const known = [...new Set([...this.currencies.active().map((currency) => currency.code), 'USD'])];
    const started = Date.now();
    const result = await this.provider.fetchLatest({
      knownCurrencies: known,
      beforeAttempt: () => this.coordination.reserveRequest(),
      maximumAttempts: trigger === 'CATCH_UP' ? 1 : undefined,
    });
    const fetchedAt = this.clock.now();
    const durationSeconds = (Date.now() - started) / 1000;

    if (result.kind === 'FAILURE') {
      this.metrics.recordRequest(this.provider.name, result.failure, durationSeconds);
      this.metrics.recordFailure(result.failure);
      const state = await this.coordination.recordFailure(result.failure);
      const log = { trigger, failure: result.failure, providerErrorCode: result.providerErrorCode, detail: result.detail, backoffUntil: state.until.toISOString() };
      if (pages(result.failure)) this.logger.error({ ...log, alert: true }, 'FX provider fetch failed; needs attention');
      else this.logger.warn(log, 'FX provider fetch failed; backing off');
      return { kind: 'FAILED', failure: result.failure, detail: result.detail };
    }

    await this.coordination.recordSuccess();
    const rates = result.rates;
    const previous = await this.snapshots.latestAccepted(this.provider.name);
    const verdict = checkSanity(rates, {
      now: fetchedAt,
      activeCurrencies: this.currencies.active().map((currency) => currency.code),
      bounds: new Map([...fx.rateBounds].map(([currency, bounds]) => [currency, { minimum: dec(bounds.minimum), maximum: dec(bounds.maximum) }])),
      maximumJumpRatio: dec(fx.maximumJumpRatio),
      jumpRatioOverrides: new Map<string, Dec>([...fx.jumpRatioOverrides].map(([currency, ratio]) => [currency, dec(ratio)])),
      cadenceSeconds: fx.cadenceSeconds,
      previous: previous ? { providerUpdatedAt: previous.providerUpdatedAt, rates: previous.rates } : undefined,
    });
    for (const [currency, ratio] of verdict.deviations) this.metrics.recordDeviation(currency, ratio.toFixed());

    const snapshotId = await this.snapshots.insert({
      provider: this.provider.name,
      baseCurrency: rates.baseCurrency,
      providerUpdatedAt: rates.providerUpdatedAt,
      providerNextUpdateAt: rates.providerNextUpdateAt,
      fetchedAt,
      status: verdict.accepted ? SnapshotStatus.ACCEPTED : SnapshotStatus.REJECTED,
      rejectionReasons: verdict.reasons,
      providerCallId: result.providerCallId,
      rates: rates.rates,
    });

    if (!verdict.accepted) {
      this.metrics.recordRequest(this.provider.name, 'REJECTED', durationSeconds);
      this.metrics.recordRejection();
      this.logger.error(
        { trigger, snapshotId, reasons: verdict.reasons, alert: true },
        'FX rates rejected by the sanity checks; the last accepted snapshot keeps serving as it ages',
      );
      return { kind: 'REJECTED', snapshotId, reasons: verdict.reasons };
    }

    this.metrics.recordRequest(this.provider.name, 'ACCEPTED', durationSeconds);
    const snapshot: RateSnapshot = {
      id: snapshotId,
      provider: this.provider.name,
      providerUpdatedAt: rates.providerUpdatedAt,
      providerNextUpdateAt: rates.providerNextUpdateAt,
      fetchedAt,
      rates: rates.rates,
    };
    try {
      await this.cache.offer(snapshot, this.cacheTimeToLiveSeconds);
    } catch (error) {
      // The durable record is written; readers fall back to it, and the poller re-seeds Redis.
      this.logger.warn({ err: error, snapshotId }, 'Could not write the FX snapshot to Redis');
    }
    this.logger.log({ trigger, snapshotId, providerUpdatedAt: rates.providerUpdatedAt.toISOString() }, 'FX rates accepted');
    return { kind: 'ACCEPTED', snapshot };
  }
}
