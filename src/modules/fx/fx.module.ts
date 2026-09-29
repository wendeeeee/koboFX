import { Inject, Injectable, Module, OnApplicationBootstrap } from '@nestjs/common';
import { ProviderCallRecorder } from '../../common/http/provider-call-recorder';
import { ProviderHttpClient } from '../../common/http/provider-http-client';
import { InvariantViolationError } from '../../common/errors';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { CurrencyRegistry } from '../currencies/currency-registry';
import { CurrencyPairRepository } from './currency-pair.repository';
import { ExchangeRateSnapshotRepository } from './exchange-rate-snapshot.repository';
import { FetchCoordination } from './fetch-coordination';
import { FxMetrics } from './fx-metrics';
import { FxPoller } from './fx-poller';
import { FxRateFetcher } from './fx-rate-fetcher';
import { FxRateService } from './fx-rate.service';
import { FxController } from './fx.controller';
import { ExchangeRateApiProvider } from './providers/exchange-rate-api.provider';
import { RateProvider } from './providers/rate-provider.port';
import { QuoteRepository } from './quote.repository';
import { QuoteService } from './quote.service';
import { RateCache } from './rate-cache';
import { RateSnapshotGuard } from './rate-snapshot.guard';

/** Fail loudly at boot: every active currency needs plausibility bounds, or no fetch could ever be accepted. */
@Injectable()
export class FxConfigurationCheck implements OnApplicationBootstrap {
  constructor(
    private readonly currencies: CurrencyRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.currencies.refresh();
    const missing = this.currencies
      .active()
      .map((currency) => currency.code)
      .filter((code) => !this.config.fx.rateBounds.has(code));
    if (missing.length > 0) {
      throw new InvariantViolationError(`FX_RATE_BOUNDS has no bounds for active currencies: ${missing.join(', ')}`, { missing });
    }
  }
}

/**
 * FX (design §4.3–§4.5, §7.4, §7.7, §14 `fx/`): the rate provider behind its port, the
 * pipeline (fetcher, sanity, snapshots, cache), the read path, the worker's poller, and
 * quotes. The provider is ExchangeRate-API (user decision 2026-09-29), keyed or open
 * access by configuration; a second provider would be bound here, behind the same port.
 */
@Module({
  controllers: [FxController],
  providers: [
    ProviderCallRecorder,
    {
      provide: RateProvider,
      inject: [APP_CONFIG, ProviderCallRecorder],
      useFactory: (config: AppConfig, recorder: ProviderCallRecorder): RateProvider => {
        const fx = config.fx;
        const client = new ProviderHttpClient(
          {
            provider: fx.providerName,
            label: 'ExchangeRate-API',
            baseUrl: new URL(fx.baseUrl.split('{apiKey}').join('key')).origin,
            timeoutMilliseconds: fx.requestTimeoutMilliseconds,
            readRetries: fx.readRetries,
            secrets: fx.apiKey ? [fx.apiKey, encodeURIComponent(fx.apiKey)] : [],
            // Rate feeds carry no secrets, and every digit of every rate is evidence.
            recordResponseAs: 'raw-json-text',
          },
          recorder,
        );
        return new ExchangeRateApiProvider({ name: fx.providerName, baseUrl: fx.baseUrl, apiKey: fx.apiKey }, client);
      },
    },
    FxConfigurationCheck,
    ExchangeRateSnapshotRepository,
    RateCache,
    FetchCoordination,
    FxMetrics,
    FxRateFetcher,
    FxRateService,
    FxPoller,
    CurrencyPairRepository,
    QuoteRepository,
    QuoteService,
    RateSnapshotGuard,
  ],
  exports: [FxRateService, FxRateFetcher, FxPoller, FxMetrics, FetchCoordination, QuoteService, RateProvider, CurrencyPairRepository, RateSnapshotGuard],
})
export class FxModule {}
