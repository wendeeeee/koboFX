import { Module } from '@nestjs/common';
import { OutboxDispatcher } from './outbox-dispatcher';
import { OutboxPoller } from './outbox-poller';
import { OutboxService } from './outbox.service';

@Module({
  providers: [OutboxService, OutboxDispatcher, OutboxPoller],
  exports: [OutboxService, OutboxDispatcher, OutboxPoller],
})
export class OutboxModule {}
