import { Module } from '@nestjs/common';
import { FlowsModule } from '../flows/flows.module';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletBalancesService } from './wallet-balances.service';
import { WalletController } from './wallet.controller';
import { WalletProvisioningService } from './wallet-provisioning.service';

@Module({
  imports: [LedgerModule, FlowsModule],
  controllers: [WalletController],
  providers: [WalletProvisioningService, WalletBalancesService],
  exports: [WalletProvisioningService, WalletBalancesService],
})
export class WalletsModule {}
