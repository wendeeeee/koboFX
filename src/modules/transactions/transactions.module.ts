import { Module } from '@nestjs/common';
import { TransactionHistoryRepository } from './transaction-history.repository';
import { TransactionHistoryService } from './transaction-history.service';
import { TransactionsController } from './transactions.controller';


@Module({
  controllers: [TransactionsController],
  providers: [TransactionHistoryRepository, TransactionHistoryService],
  exports: [TransactionHistoryRepository, TransactionHistoryService],
})
export class TransactionsModule {}
