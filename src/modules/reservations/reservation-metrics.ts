import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../database/transaction/unit-of-work';


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
