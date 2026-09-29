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

/**
 * `POST /wallet/trade` — execute a quote (design §7.7). No current rate is needed: the
 * quote locked every amount, and they are posted VERBATIM, with the quote's own provenance
 * (its snapshot, provider times, spread and mid).
 *
 * The quote is consumed inside the conversion's transaction, after the user row lock, so a
 * trade that then fails (`INSUFFICIENT_FUNDS`, `FUNDS_RESERVED`, suspended, a limit) rolls
 * the consumption back: that key stores the refusal, and the quote stays usable with a new
 * key until it expires. Absent or another user's → `404 QUOTE_NOT_FOUND`; used →
 * `409 QUOTE_ALREADY_USED`; expired → `409 QUOTE_EXPIRED`.
 */
@Injectable()
export class TradeService {
  constructor(
    private readonly conversions: ConversionService,
    private readonly quotes: QuoteService,
    private readonly currencies: CurrencyRegistry,
    private readonly rounding: RoundingPolicy,
  ) {}

  async trade(userId: string, request: TradeDto, idempotencyKey: string | undefined): Promise<ConversionView> {
    // Until the quote is read, a refusal has no currencies to count under.
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

  /**
   * Don't trust even our own row: the quote's four amounts must be exactly what pricing
   * gives from the quote's own USD mids, spread, mode and stated amount. A mismatch is our
   * bug (or tampering) — `INVARIANT_VIOLATION`, nothing posted, the quote left unconsumed.
   */
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
