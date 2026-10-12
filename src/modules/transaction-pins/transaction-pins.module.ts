import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { OneTimePasswordsModule } from '../auth/one-time-passwords/one-time-passwords.module';
import { OutboxModule } from '../outbox/outbox.module';
import { UsersModule } from '../users/users.module';
import { TransactionPinService } from './transaction-pin.service';
import { TransactionPinsController } from './transaction-pins.controller';

/** The transaction PIN: its routes, and `TransactionPinService.verify` for the withdrawal and trading routes. */
@Module({
  imports: [AuthModule, OneTimePasswordsModule, UsersModule, AuditModule, OutboxModule],
  controllers: [TransactionPinsController],
  providers: [TransactionPinService],
  exports: [TransactionPinService],
})
export class TransactionPinsModule {}
