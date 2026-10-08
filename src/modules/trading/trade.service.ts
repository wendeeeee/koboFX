import { Injectable } from '@nestjs/common';
import { InvariantViolationError } from '../../common/errors';
import { RoundingPolicy } from '../../common/money';
import { CurrencyRegistry } from '../currencies/currency-registry';
import { priceConversion } from '../fx/pricing';
import { Quote } from '../fx/quote.repository';
import { QuoteService } from '../fx/quote.service';
import { ConversionReason, ConversionService } from './conversion.service';
import { ConversionView } from './conversion.view';
import { TradeDto } from './dto/trade.dto';


@Injectable()
export class TradeService {
  constructor(
    private readonly conversions: ConversionService,
    private readonly quotes: QuoteService,
    private readonly currencies: CurrencyRegistry,
    private readonly rounding: RoundingPolicy,
  ) {}

  async trade(userId: string, request: TradeDto, idempotencyKey: string | undefined): Promise<ConversionView> {
    const pair = { from: 'UNKNOWN', to: 'UNKNOWN' };
    return this.conversions.execute(userId, idempotencyKey, pair, async () => {
      const quote = await this.quotes.consume(request.quoteId, userId);
      pair.from = quote.sourceCurrency;
      pair.to = quote.targetCurrency;
      const source = this.currencies.require(quote.sourceCurrency);
      const target = this.currencies.require(quote.targetCurrency);
      this.assertQuoteReproduces(quote);
      return {
        source,
        target,
        amountMode: quote.amountMode,
        amounts: {
          sourceAmountMinor: quote.sourceAmountMinor,
          targetAmountMinor: quote.targetAmountMinor,
          targetMidValueMinor: quote.targetMidValueMinor,
          revenueMinor: quote.revenueMinor,
        },
        midRate: quote.midRate,
        clientRate: quote.clientRate,
        spreadBasisPoints: quote.spreadBasisPoints,
        rateSnapshotId: quote.rateSnapshotId,
        rateProvider: quote.rateProvider,
        rateProviderUpdatedAt: quote.rateProviderUpdatedAt,
        rateFetchedAt: quote.rateFetchedAt,
        quoteId: quote.id,
        reason: ConversionReason.QUOTED_TRADE,
      };
    });
  }


  private assertQuoteReproduces(quote: Quote): void {
    const source = this.currencies.require(quote.sourceCurrency);
    const target = this.currencies.require(quote.targetCurrency);
    const repriced = priceConversion(
      {
        source,
        target,
        sourceUsdRate: quote.sourceReferenceRate,
        targetUsdRate: quote.targetReferenceRate,
        spreadBasisPoints: quote.spreadBasisPoints,
        mode: quote.amountMode,
        amountMinor: quote.amountMode === 'SOURCE' ? quote.sourceAmountMinor : quote.targetAmountMinor,
      },
      this.rounding,
    );
    const stored = [quote.sourceAmountMinor, quote.targetAmountMinor, quote.targetMidValueMinor, quote.revenueMinor];
    const expected = [repriced.sourceAmountMinor, repriced.targetAmountMinor, repriced.targetMidValueMinor, repriced.revenueMinor];
    if (stored.some((amount, index) => amount !== expected[index]) || !repriced.midRate.eq(quote.midRate)) {
      throw new InvariantViolationError('A quote does not reproduce from its own rates.', {
        quoteId: quote.id,
        stored: stored.map(String),
        repriced: expected.map(String),
      });
    }
  }
}
