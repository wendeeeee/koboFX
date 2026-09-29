import { Inject, Injectable } from '@nestjs/common';
import { PollingLoop } from '../../common/polling/polling-loop';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { FlowRepository } from './flow.repository';
import { FlowRunner } from './flow-runner';

/**
 * The independent driver (design §7.5 rule 2; handbook: "something must resume stalled
 * flows"): claims due flows with `FOR UPDATE SKIP LOCKED` — several resumers never
 * block on, or double-process, the same flow — and runs one step of each. A crash of
 * whoever started a flow cannot strand it.
 */
@Injectable()
export class FlowResumer {
  private readonly loop: PollingLoop;

  constructor(
    private readonly repository: FlowRepository,
    private readonly runner: FlowRunner,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.loop = new PollingLoop(
      FlowResumer.name,
      async () => ({ fullBatch: (await this.resumeDue()) >= this.config.flows.batchSize }),
      () => this.config.flows.pollIntervalMilliseconds,
    );
  }

  /** One pass: claim a batch of due flows and run one step of each. Returns how many ran. */
  async resumeDue(batchSize = this.config.flows.batchSize): Promise<number> {
    const flows = await this.repository.claimDue(batchSize, this.config.flows.leaseSeconds);
    await Promise.allSettled(flows.map((flow) => this.runner.runClaimed(flow)));
    return flows.length;
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }
}
