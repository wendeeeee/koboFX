import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { OutboxDispatcher } from './outbox-dispatcher';

/** The worker's loop: dispatch, sleep, repeat; drains a full batch without sleeping. */
@Injectable()
export class OutboxPoller {
  private readonly logger = new Logger(OutboxPoller.name);
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly dispatcher: OutboxDispatcher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let claimed = 0;
      try {
        claimed = (await this.dispatcher.dispatchDue()).claimed;
      } catch (error) {
        this.logger.error({ err: error }, 'Outbox dispatch cycle failed');
      }
      if (claimed < this.config.outbox.batchSize) {
        await new Promise((resolve) => setTimeout(resolve, this.config.outbox.pollIntervalMilliseconds));
      }
    }
  }
}
