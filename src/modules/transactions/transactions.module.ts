import { Module } from '@nestjs/common';
import { TransactionHistoryRepository } from './transaction-history.repository';
import { TransactionHistoryService } from './transaction-history.service';
import { TransactionsController } from './transactions.controller';

/**
 * Transaction history — read models (design §7.8, §14 `transactions/`). Depends on tables only:
 * no ledger service, no FX, no trading, no Redis (the rate-limit guard aside), so history stays
 * up when FX and trading are down (design §16). The repository is exported for Phase 10's admin
 * views.
 */
@Module({
  controllers: [TransactionsController],
  providers: [TransactionHistoryRepository, TransactionHistoryService],
  exports: [TransactionHistoryRepository],
})
export class TransactionsModule {}
