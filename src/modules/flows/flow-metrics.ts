import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { UnitOfWork } from '../../database/transaction/unit-of-work';

export interface StalledFlowCount {
  readonly flowType: string;
  readonly state: string;
  readonly count: number;
}

/**
 * `flows_stalled{flow_type,state}` (design §10; pages at 30 minutes): incomplete flows
 * whose state has not changed for the configured time. A gauge read from the database —
 * correct across processes. No metrics backend yet; a later phase exports it.
 */
@Injectable()
export class FlowMetrics {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async flowsStalled(): Promise<StalledFlowCount[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT flow_type::text AS flow_type, state, count(*)::int AS count
         FROM flow_instances
        WHERE completed_at IS NULL AND state_changed_at < now() - make_interval(mins => $1)
        GROUP BY flow_type, state ORDER BY flow_type, state`,
      [this.config.flows.stalledAfterMinutes],
    )) as { flow_type: string; state: string; count: number }[];
    return rows.map((row) => ({ flowType: row.flow_type, state: row.state, count: row.count }));
  }
}
