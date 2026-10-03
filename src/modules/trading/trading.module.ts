import { Inject, Injectable, Module, OnApplicationBootstrap } from '@nestjs/common';
import { InvariantViolationError } from '../../common/errors';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { AuditModule } from '../audit/audit.module';
import { FlowsModule } from '../flows/flows.module';
import { CurrencyPairRepository } from '../fx/currency-pair.repository';
import { FxModule } from '../fx/fx.module';
import { LedgerModule } from '../ledger/ledger.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { ConversionService } from './conversion.service';
import { ConvertService } from './convert.service';
import { TradeService } from './trade.service';
import { TradingMetrics } from './trading-metrics';
import { TradingController } from './trading.controller';


@Injectable()
export class TradingConfigurationCheck implements OnApplicationBootstrap {
  constructor(
    private readonly pairs: CurrencyPairRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const sources = [...new Set((await this.pairs.active()).map((pair) => pair.sourceCurrency))];
    const missing = sources.filter((currency) => !this.config.conversion.limits.has(currency));
    if (missing.length > 0) {
      throw new InvariantViolationError(`CONVERSION_LIMITS has no limits for traded currencies: ${missing.join(', ')}`, { missing });
    }
  }
}


@Module({
  imports: [LedgerModule, ReservationsModule, FlowsModule, OutboxModule, AuditModule, FxModule],
  controllers: [TradingController],
  providers: [ConversionService, ConvertService, TradeService, TradingMetrics, TradingConfigurationCheck],
  exports: [ConversionService, TradingMetrics],
})
export class TradingModule {}
