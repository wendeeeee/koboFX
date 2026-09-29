import { Injectable } from '@nestjs/common';

/**
 * `idempotency_replays_total` (design §10): per-process counter of responses answered
 * from a stored outcome. No metrics backend yet; a later phase exports it.
 */
@Injectable()
export class IdempotencyMetrics {
  private replays = 0;

  get idempotencyReplaysTotal(): number {
    return this.replays;
  }

  recordReplay(): void {
    this.replays += 1;
  }
}
