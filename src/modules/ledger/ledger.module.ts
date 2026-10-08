import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChartOfAccountsService } from './chart-of-accounts.service';
import { AccountEntity, LedgerEntryEntity, PeriodLockEntity, TransactionEntity } from './entities';
import { LedgerChecksService } from './ledger-checks.service';
import { LedgerService } from './ledger.service';

/**
 * The ledger (design §5, §6, §14). `LedgerService.post()` is the one write path to
 * money; `ChartOfAccountsService` creates zero-balance accounts; `LedgerChecksService`
 * is read-only.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AccountEntity, TransactionEntity, LedgerEntryEntity, PeriodLockEntity])],
  providers: [LedgerService, ChartOfAccountsService, LedgerChecksService],
  exports: [LedgerService, ChartOfAccountsService, LedgerChecksService],
})
export class LedgerModule {}
