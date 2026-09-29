import { Injectable } from '@nestjs/common';

export interface RequestDurationSummary {
  readonly provider: string;
  readonly outcome: string;
  readonly count: number;
  readonly totalSeconds: number;
  readonly maximumSeconds: number;
}

/**
 * FX observability hooks (design §10), in the Phase 3/5 style — no metrics backend yet;
 * a later phase exports these:
 *
 * - `fx_rate_age_seconds{pair}` and `fx_rate_fetch_age_seconds` — gauges computed on read
 *   by `FxRateService.metrics()` from the served snapshot (the rate's own age, from the
 *   provider's publication time, and how long ago we fetched it);
 * - `fx_provider_deviation_ratio{currency}` — redefined for one provider: the jump from the
 *   last accepted value, recorded per fetch;
 * - `fx_provider_request_duration_seconds{provider,outcome}` — per fetch;
 * - `fx_rate_rejections_total` and `fx_provider_failures_total{kind}` — counters;
 * - the quota gauge is `FetchCoordination.usage()` (shared across instances, in Redis).
 */
@Injectable()
export class FxMetrics {
  private readonly deviations = new Map<string, string>();
  private readonly durations = new Map<string, { count: number; totalSeconds: number; maximumSeconds: number }>();
  private readonly failures = new Map<string, number>();
  private rejections = 0;

  recordDeviation(currency: string, ratio: string): void {
    this.deviations.set(currency, ratio);
  }

  recordRequest(provider: string, outcome: string, durationSeconds: number): void {
    const key = `${provider}|${outcome}`;
    const entry = this.durations.get(key) ?? { count: 0, totalSeconds: 0, maximumSeconds: 0 };
    entry.count += 1;
    entry.totalSeconds += durationSeconds;
    entry.maximumSeconds = Math.max(entry.maximumSeconds, durationSeconds);
    this.durations.set(key, entry);
  }

  recordRejection(): void {
    this.rejections += 1;
  }

  recordFailure(kind: string): void {
    this.failures.set(kind, (this.failures.get(kind) ?? 0) + 1);
  }

  /** `fx_provider_deviation_ratio{currency}`, as decimal strings. */
  deviationRatios(): Record<string, string> {
    return Object.fromEntries(this.deviations);
  }

  requestDurations(): RequestDurationSummary[] {
    return [...this.durations].map(([key, entry]) => {
      const [provider, outcome] = key.split('|');
      return { provider, outcome, ...entry };
    });
  }

  rejectionsTotal(): number {
    return this.rejections;
  }

  failuresTotal(): Record<string, number> {
    return Object.fromEntries(this.failures);
  }
}
