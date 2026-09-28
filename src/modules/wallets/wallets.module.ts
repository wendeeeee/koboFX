import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletProvisioningService } from './wallet-provisioning.service';

/** Wallet provisioning. The `GET /wallet` read model arrives in a later phase. */
@Module({
  imports: [LedgerModule],
  providers: [WalletProvisioningService],
  exports: [WalletProvisioningService],
})
export class WalletsModule {}
