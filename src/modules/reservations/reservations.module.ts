import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LedgerModule } from '../ledger/ledger.module';
import { ReservationEntity } from './entities/reservation.entity';
import { ReservationChecksService } from './reservation-checks.service';
import { ReservationMetrics } from './reservation-metrics';
import { ReservationService } from './reservation.service';
import { ReservationSweeper } from './reservation-sweeper';

/**
 * Funds reservation (design §6.3, §14): hold, settle, release, expire. The only writer
 * of `accounts.reserved_minor`; settlement moves money through `LedgerService.post()`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ReservationEntity]), LedgerModule],
  providers: [ReservationService, ReservationChecksService, ReservationMetrics, ReservationSweeper],
  exports: [ReservationService, ReservationChecksService, ReservationMetrics, ReservationSweeper],
})
export class ReservationsModule {}
