import { Injectable } from '@nestjs/common';

export interface ConversionCount {
  readonly from: string;
  readonly to: string;
  /** `POSTED`, or the error code that refused it. */
  readonly outcome: string;
  readonly count: number;
}

/**
 * `conversions_total{from,to,outcome}` (design §10), in the Phase 3/5/6 style — an
 * in-process counter; no metrics backend yet. Counted once per handled request: a replay
 * served by the idempotency barrier never reaches the handler, so it is not counted twice.
 */
@Injectable()
export class TradingMetrics {
  private readonly conversions = new Map<string, number>();

  recordConversion(from: string, to: string, outcome: string): void {
    const key = `${from}|${to}|${outcome}`;
    this.conversions.set(key, (this.conversions.get(key) ?? 0) + 1);
  }

  conversionsTotal(): ConversionCount[] {
    return [...this.conversions].map(([key, count]) => {
      const [from, to, outcome] = key.split('|');
      return { from, to, outcome, count };
    });
  }
}
