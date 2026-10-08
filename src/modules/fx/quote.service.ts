import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { InvariantViolationError, ValidationError } from '../../common/errors';
import { RoundingPolicy, parseMinorString } from '../../common/money';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { CurrencyRegistry } from '../currencies/currency-registry';
import { AmountTooSmallError } from '../flows/funding/funding.errors';
import { CurrencyPairRepository } from './currency-pair.repository';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { FxRateService, ServedSnapshot } from './fx-rate.service';
import { QuoteAlreadyUsedError, QuoteExpiredError, QuoteNotFoundError, SameCurrencyError, UnsupportedCurrencyPairError } from './fx.errors';
import { QuoteAmountMode, displayRate, priceConversion } from './pricing';
import { Quote, QuoteRepository } from './quote.repository';

export type QuoteStatus = 'OPEN' | 'CONSUMED' | 'EXPIRED';

export interface QuoteView {
  readonly quoteId: string;
  readonly from: string;
  readonly to: string;
  readonly amountMode: QuoteAmountMode;
  readonly sourceAmount: string;
  readonly targetAmount: string;
  readonly midRate: string;
  readonly clientRate: string;
  readonly spreadBasisPoints: number;
  readonly rate: { readonly provider: string; readonly asOf: string; readonly fetchedAt: string; readonly snapshotId: string };
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly status: QuoteStatus;
}

@Injectable()
export class QuoteService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly quotes: QuoteRepository,
    private readonly pairs: CurrencyPairRepository,
    private readonly currencies: CurrencyRegistry,
    private readonly rates: FxRateService,
    private readonly rounding: RoundingPolicy,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(userId: string, request: CreateQuoteDto, prepared: ServedSnapshot | undefined): Promise<QuoteView> {
    const source = this.currencies.require(request.from);
    const target = this.currencies.require(request.to);
    if (source.code === target.code) throw new SameCurrencyError(source.code);
    if ((request.sourceAmount === undefined) === (request.targetAmount === undefined)) {
      throw new ValidationError('Give exactly one of sourceAmount or targetAmount.', { fields: ['sourceAmount', 'targetAmount'] });
    }
    const mode = request.sourceAmount !== undefined ? QuoteAmountMode.SOURCE : QuoteAmountMode.TARGET;
    const amountMinor = parseMinorString((request.sourceAmount ?? request.targetAmount) as string);

    return this.unitOfWork.run(async () => {
      const pair = await this.pairs.find(source.code, target.code);
      if (!pair?.isActive) throw new UnsupportedCurrencyPairError(source.code, target.code);
      const served = this.rates.requireExecutable(prepared);
      const sourceUsdRate = served.snapshot.rates.get(source.code);
      const targetUsdRate = served.snapshot.rates.get(target.code);
      if (!sourceUsdRate || !targetUsdRate) {
        throw new InvariantViolationError('An accepted snapshot lacks a rate for an active currency.', { snapshotId: served.snapshot.id });
      }
      const priced = priceConversion(
        { source, target, sourceUsdRate, targetUsdRate, spreadBasisPoints: pair.spreadBasisPoints, mode, amountMinor },
        this.rounding,
      );
      const minimum = pair.minimumSourceAmountMinor;
      if (priced.sourceAmountMinor < minimum || priced.targetAmountMinor === 0n) {
        throw new AmountTooSmallError('The amount is below the minimum for this currency pair.', {
          from: source.code,
          to: target.code,
          minimumSourceAmount: minimum.toString(),
          sourceAmount: priced.sourceAmountMinor.toString(),
          targetAmount: priced.targetAmountMinor.toString(),
        });
      }
      const issuedAt = this.clock.now();
      const quote = await this.quotes.insert({
        userId,
        sourceCurrency: source.code,
        targetCurrency: target.code,
        amountMode: mode,
        sourceAmountMinor: priced.sourceAmountMinor,
        targetAmountMinor: priced.targetAmountMinor,
        targetMidValueMinor: priced.targetMidValueMinor,
        revenueMinor: priced.revenueMinor,
        midRate: priced.midRate,
        clientRate: priced.clientRate,
        spreadBasisPoints: pair.spreadBasisPoints,
        sourceReferenceRate: sourceUsdRate,
        targetReferenceRate: targetUsdRate,
        rateSnapshotId: served.snapshot.id,
        rateProvider: served.snapshot.provider,
        rateProviderUpdatedAt: served.snapshot.providerUpdatedAt,
        rateFetchedAt: served.snapshot.fetchedAt,
        issuedAt,
        expiresAt: new Date(issuedAt.getTime() + this.config.fx.quoteTimeToLiveSeconds * 1000),
      });
      return this.view(quote);
    });
  }

  async find(userId: string, quoteId: string): Promise<QuoteView> {
    const quote = await this.quotes.findForUser(quoteId, userId);
    if (!quote) throw new QuoteNotFoundError(quoteId);
    return this.view(quote);
  }

  async consume(quoteId: string, userId: string): Promise<Quote> {
    return this.unitOfWork.run(async () => {
      const now = this.clock.now();
      const consumed = await this.quotes.consume(quoteId, userId, now);
      if (consumed) return consumed;
      const existing = await this.quotes.findForUser(quoteId, userId);
      if (!existing) throw new QuoteNotFoundError(quoteId);
      if (existing.consumedAt !== null) throw new QuoteAlreadyUsedError(quoteId);
      if (existing.expiresAt.getTime() <= now.getTime()) throw new QuoteExpiredError(quoteId, existing.expiresAt);
      throw new InvariantViolationError('A quote was neither consumed, expired nor already used.', { quoteId });
    });
  }

  private view(quote: Quote): QuoteView {
    const now = this.clock.now().getTime();
    const status: QuoteStatus = quote.consumedAt !== null ? 'CONSUMED' : quote.expiresAt.getTime() <= now ? 'EXPIRED' : 'OPEN';
    return {
      quoteId: quote.id,
      from: quote.sourceCurrency,
      to: quote.targetCurrency,
      amountMode: quote.amountMode,
      sourceAmount: quote.sourceAmountMinor.toString(),
      targetAmount: quote.targetAmountMinor.toString(),
      midRate: displayRate(quote.midRate),
      clientRate: displayRate(quote.clientRate),
      spreadBasisPoints: quote.spreadBasisPoints,
      rate: {
        provider: quote.rateProvider,
        asOf: quote.rateProviderUpdatedAt.toISOString(),
        fetchedAt: quote.rateFetchedAt.toISOString(),
        snapshotId: quote.rateSnapshotId,
      },
      issuedAt: quote.issuedAt.toISOString(),
      expiresAt: quote.expiresAt.toISOString(),
      status,
    };
  }
}

