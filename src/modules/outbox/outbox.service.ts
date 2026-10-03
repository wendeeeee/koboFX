import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { OutboxEventType } from './outbox.types';

@Injectable()
export class OutboxService {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async enqueue(eventType: OutboxEventType, aggregateId: string, payload: object): Promise<string> {
    const [row] = (await this.unitOfWork
      .requireTransaction()
      .query(`INSERT INTO outbox_events (event_type, aggregate_id, payload) VALUES ($1, $2, $3) RETURNING id`, [
        eventType,
        aggregateId,
        JSON.stringify(payload),
      ])) as { id: string }[];
    return row.id;
  }
}
