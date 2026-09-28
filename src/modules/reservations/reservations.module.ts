import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LedgerModule } from '../ledger/ledger.module';
import { ReservationEntity } from './entities/reservation.entity';
import { ReservationChecksService } from './reservation-checks.service';
import { ReservationMetrics } from './reservation-metrics';
import { ReservationService } from './reservation.service';

/**
 * Funds reservation (design §6.3, §14): hold, settle, release, expire. The only writer
 * of `accounts.reserved_minor`; settlement moves money through `LedgerService.post()`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ReservationEntity]), LedgerModule],
  providers: [ReservationService, ReservationChecksService, ReservationMetrics],
  exports: [ReservationService, ReservationChecksService, ReservationMetrics],
})
export class ReservationsModule {}
