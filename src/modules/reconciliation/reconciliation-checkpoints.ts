import { Injectable } from '@nestjs/common';

export enum ReconciliationCheckpoint {
  AFTER_SNAPSHOT = 'AFTER_SNAPSHOT',
  BEFORE_COMMIT = 'BEFORE_COMMIT',
  AFTER_SETTLEMENT_COMMIT = 'AFTER_SETTLEMENT_COMMIT',
  BEFORE_FINISH = 'BEFORE_FINISH',
}

export interface ReconciliationCheckpointContext {
  readonly runId: string;
  readonly kind: string;
}


@Injectable()
export class ReconciliationCheckpoints {
  async reached(_point: ReconciliationCheckpoint, _context: ReconciliationCheckpointContext): Promise<void> {
  }
}
