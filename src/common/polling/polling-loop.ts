import { Logger } from '@nestjs/common';

export interface PollingTickResult {
  /** True when the tick found a full batch: run again at once instead of sleeping. */
  readonly fullBatch: boolean;
}

/**
 * The worker's loop, shared by the outbox dispatcher, the flow resumer, the webhook
 * processor and the reservation sweeper: run a tick, sleep, repeat — drain full
 * batches without sleeping, survive a failing tick (logged), and on `stop()` finish
 * the in-flight tick before resolving (graceful shutdown). The sleep is interruptible
 * so shutdown does not wait out an idle interval.
 */
export class PollingLoop {
  private readonly logger: Logger;
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly tick: () => Promise<PollingTickResult>,
    private readonly intervalMilliseconds: () => number,
  ) {
    this.logger = new Logger(name);
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let fullBatch = false;
      try {
        fullBatch = (await this.tick()).fullBatch;
      } catch (error) {
        this.logger.error({ err: error, loop: this.name }, `${this.name} cycle failed`);
      }
      if (!fullBatch && this.running) await this.sleep(this.intervalMilliseconds());
    }
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, milliseconds);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}
