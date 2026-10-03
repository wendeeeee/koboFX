import { Injectable } from '@nestjs/common';

export interface ConversionCount {
  readonly from: string;
  readonly to: string;
  readonly outcome: string;
  readonly count: number;
}


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
