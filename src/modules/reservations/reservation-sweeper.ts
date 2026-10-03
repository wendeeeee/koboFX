import { Inject, Injectable, Logger } from '@nestjs/common';
import { PollingLoop } from '../../common/polling/polling-loop';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { ReservationService } from './reservation.service';

const SWEEP_BATCH_SIZE = 100;

@Injectable()
export class ReservationSweeper {
  private readonly logger = new Logger(ReservationSweeper.name);
  private readonly loop: PollingLoop;

  constructor(
    private readonly reservations: ReservationService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.loop = new PollingLoop(
      ReservationSweeper.name,
      async () => ({ fullBatch: (await this.sweep()) >= SWEEP_BATCH_SIZE }),
      () => config.flows.reservationSweepIntervalMilliseconds,
    );
  }

  async sweep(now: Date = new Date()): Promise<number> {
    const { expired } = await this.reservations.expireDue(now, SWEEP_BATCH_SIZE);
    if (expired.length > 0) {
      this.logger.warn({ expired: expired.map((reservation) => reservation.id) }, 'Reservations expired by the sweeper');
    }
    return expired.length;
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }
}
