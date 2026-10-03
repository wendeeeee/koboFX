import { Injectable } from '@nestjs/common';

export interface RequestDurationSummary {
  readonly provider: string;
  readonly outcome: string;
  readonly count: number;
  readonly totalSeconds: number;
  readonly maximumSeconds: number;
}

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
