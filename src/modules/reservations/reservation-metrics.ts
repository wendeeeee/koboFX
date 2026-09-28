import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../database/transaction/unit-of-work';

/**
 * Hooks for the two reservation metrics of design §10. There is no metrics backend
 * yet; a later phase exports these.
 *
 * - `reservations_active` is a gauge read from the database — an in-process count
 *   would be wrong as soon as there are two processes.
 * - `reservations_expired_total` is a per-process counter of reservations this
 *   process's sweeper expired. Anything above zero means some flow failed to resolve
 *   its own hold (§16 "Reservation orphaned"): the sweeper is the safety net, not the
 *   mechanism.
 */
@Injectable()
export class ReservationMetrics {
  private expiredTotal = 0;

  constructor(private readonly unitOfWork: UnitOfWork) {}

  get reservationsExpiredTotal(): number {
    return this.expiredTotal;
  }

  recordExpired(count: number): void {
    this.expiredTotal += count;
  }

  async reservationsActive(): Promise<number> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT count(*)::int AS active FROM reservations WHERE status = 'ACTIVE'`,
    )) as { active: number }[];
    return row.active;
  }
}
