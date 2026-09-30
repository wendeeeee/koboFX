import { Inject, Injectable } from '@nestjs/common';
import { PollingLoop } from '../../../common/polling/polling-loop';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { ApprovalService } from '../approvals/approval.service';

/**
 * The worker's control monitor (Phase 10 plan §E.2, §E.7): each tick records PENDING approvals past their expiry
 * as EXPIRED (audited) and pages ONCE for every break-glass use still unreviewed after its window
 * (`BreakGlassReviewOverdue.v1` + audit), then refreshes the `break_glass_unreviewed{overdue}` gauge.
 */
@Injectable()
export class AdminMonitor {
  private readonly loop: PollingLoop;

  constructor(
    private readonly approvals: ApprovalService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.loop = new PollingLoop(
      AdminMonitor.name,
      async () => {
        const { expired, overdueAlerted } = await this.tick();
        return { fullBatch: expired >= 100 || overdueAlerted >= 100 };
      },
      () => config.admin.monitorTickMilliseconds,
    );
  }

  tick(): Promise<{ expired: number; overdueAlerted: number }> {
    return this.approvals.sweep();
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }
}
