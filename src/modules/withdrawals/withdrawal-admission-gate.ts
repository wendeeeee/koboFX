import { Inject, Injectable } from '@nestjs/common';
import { PollingLoop } from '../../common/polling/polling-loop';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { WithdrawalsDisabledError } from './withdrawals.errors';

export const WITHDRAWAL_WORKER_CAPABILITY = 'paystack-withdrawals';
const HEARTBEAT_INTERVAL_MILLISECONDS = 15_000;

/**
 * Whether NEW beneficiaries and withdrawals may be admitted (WITHDRAWAL_PLAN.md §K): the switch is on AND a worker able
 * to process them has beaten within the configured freshness (measured by the database's clock). Checked inside the
 * admission services — after the idempotency barrier's replay — so an earlier request keeps its original answer.
 */
@Injectable()
export class WithdrawalAdmissionGate {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async assertOpen(): Promise<void> {
    if (!this.config.withdrawals.enabled) {
      throw new WithdrawalsDisabledError('New withdrawals are switched off.', { reason: 'disabled' });
    }
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT heartbeat_at > now() - make_interval(secs => $2) AS fresh FROM worker_capabilities WHERE capability = $1`,
      [WITHDRAWAL_WORKER_CAPABILITY, this.config.withdrawals.workerHeartbeatFreshnessSeconds],
    )) as { fresh: boolean }[];
    if (!row?.fresh) {
      throw new WithdrawalsDisabledError('No worker is processing withdrawals right now.', { reason: 'no-worker' });
    }
  }
}

/** The worker side: beats while the withdrawal flows are registered in this process. */
@Injectable()
export class WithdrawalWorkerHeartbeat {
  private readonly loop: PollingLoop;

  constructor(private readonly unitOfWork: UnitOfWork) {
    this.loop = new PollingLoop(
      WithdrawalWorkerHeartbeat.name,
      async () => {
        await this.beat();
        return { fullBatch: false };
      },
      () => HEARTBEAT_INTERVAL_MILLISECONDS,
    );
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  async beat(): Promise<void> {
    await this.unitOfWork.manager.query(
      `INSERT INTO worker_capabilities (capability, heartbeat_at) VALUES ($1, now())
       ON CONFLICT (capability) DO UPDATE SET heartbeat_at = now()`,
      [WITHDRAWAL_WORKER_CAPABILITY],
    );
  }
}
