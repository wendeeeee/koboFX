import { Inject, Injectable } from '@nestjs/common';
import { PollingLoop } from '../../common/polling/polling-loop';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { OutboxDispatcher } from './outbox-dispatcher';

/** The worker's outbox loop: dispatch, sleep, repeat; drains a full batch without sleeping. */
@Injectable()
export class OutboxPoller {
  private readonly loop: PollingLoop;

  constructor(dispatcher: OutboxDispatcher, @Inject(APP_CONFIG) config: AppConfig) {
    this.loop = new PollingLoop(
      OutboxPoller.name,
      async () => ({ fullBatch: (await dispatcher.dispatchDue()).claimed >= config.outbox.batchSize }),
      () => config.outbox.pollIntervalMilliseconds,
    );
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }
}
