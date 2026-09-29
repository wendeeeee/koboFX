import { Inject, Injectable } from '@nestjs/common';
import { InvalidAmountError, InvariantViolationError, ValidationError } from '../../common/errors';
import { RoundingPolicy, parseMinorString } from '../../common/money';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { CurrencyRegistry } from '../currencies/currency-registry';
import { AmountTooLargeError, AmountTooSmallError } from '../flows/funding/funding.errors';
import { CurrencyPairRepository } from '../fx/currency-pair.repository';
import { FxRateService, ServedSnapshot } from '../fx/fx-rate.service';
import { SameCurrencyError, UnsupportedCurrencyPairError } from '../fx/fx.errors';
import { PricedConversion, QuoteAmountMode, priceConversion } from '../fx/pricing';
import { assertWithinConversionMaximum } from './conversion-limits';
import { ConversionReason, ConversionService } from './conversion.service';
import { ConversionView } from './conversion.view';
import { ConvertDto } from './dto/convert.dto';
import { PriceLimitExceededError } from './trading.errors';

/**
 * `POST /wallet/convert` — a market conversion (design §7.7). Validates the request, prices
 * it ONCE from the snapshot `RateSnapshotGuard` prepared before the barrier (judged
 * executable at the moment of use, else `503 FX_RATE_STALE` — transient, nothing stored),
 * applies the pair minimum, the per-conversion maximum and the caller's price bound, then
 * hands the priced order to the shared primitive.
 */
@Injectable()
export class ConvertService {
  constructor(
    private readonly conversions: ConversionService,
    private readonly currencies: CurrencyRegistry,
    private readonly pairs: CurrencyPairRepository,
    private readonly rates: FxRateService,
    private readonly rounding: RoundingPolicy,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async convert(userId: string, request: ConvertDto, prepared: ServedSnapshot | undefined, idempotencyKey: string | undefined): Promise<ConversionView> {
    const pair = { from: request.from, to: request.to };
    return this.conversions.execute(userId, idempotencyKey, pair, async () => {
      const { mode, amountMinor, bound } = this.validate(request);
      const source = this.currencies.require(request.from);
      const target = this.currencies.require(request.to);
      if (source.code === target.code) throw new SameCurrencyError(source.code);

      const pairRow = await this.pairs.find(source.code, target.code);
      if (!pairRow?.isActive) throw new UnsupportedCurrencyPairError(source.code, target.code);
      const served = this.rates.requireExecutable(prepared);
      const sourceUsdRate = served.snapshot.rates.get(source.code);
      const targetUsdRate = served.snapshot.rates.get(target.code);
      if (!sourceUsdRate || !targetUsdRate) {
        throw new InvariantViolationError('An accepted snapshot lacks a rate for an active currency.', { snapshotId: served.snapshot.id });
      }

      let priced: PricedConversion;
      try {
        priced = priceConversion(
          { source, target, sourceUsdRate, targetUsdRate, spreadBasisPoints: pairRow.spreadBasisPoints, mode, amountMinor },
          this.rounding,
        );
      } catch (error) {
        // A TARGET amount so large its debit leaves the BIGINT range: too large, not malformed.
        if (error instanceof InvalidAmountError) {
          throw new AmountTooLargeError('The amount is too large to convert.', { currency: source.code }, { cause: error });
        }
        throw error;
      }
      const pricedDetails = {
        from: source.code,
        to: target.code,
        sourceAmount: priced.sourceAmountMinor.toString(),
        targetAmount: priced.targetAmountMinor.toString(),
      };
      if (priced.sourceAmountMinor < pairRow.minimumSourceAmountMinor || priced.targetAmountMinor === 0n) {
        throw new AmountTooSmallError('The amount is below the minimum for this currency pair.', {
          ...pricedDetails,
          minimumSourceAmount: pairRow.minimumSourceAmountMinor.toString(),
        });
      }
      assertWithinConversionMaximum(this.config.conversion, source.code, priced);
      if (bound !== undefined) {
        const breached = mode === QuoteAmountMode.SOURCE ? priced.targetAmountMinor < bound : priced.sourceAmountMinor > bound;
        if (breached) {
          throw new PriceLimitExceededError('The market price is worse than the limit you set.', {
            ...pricedDetails,
            ...(mode === QuoteAmountMode.SOURCE ? { minimumTargetAmount: bound.toString() } : { maximumSourceAmount: bound.toString() }),
          });
        }
      }

      return {
        source,
        target,
        amountMode: mode,
        amounts: priced,
        midRate: priced.midRate,
        clientRate: priced.clientRate,
        spreadBasisPoints: pairRow.spreadBasisPoints,
        rateSnapshotId: served.snapshot.id,
        rateProvider: served.snapshot.provider,
        rateProviderUpdatedAt: served.snapshot.providerUpdatedAt,
        rateFetchedAt: served.snapshot.fetchedAt,
        reason: ConversionReason.MARKET_CONVERSION,
      };
    });
  }

  /** Exactly one amount; at most the bound that matches its mode. */
  private validate(request: ConvertDto): { mode: QuoteAmountMode; amountMinor: bigint; bound: bigint | undefined } {
    if ((request.sourceAmount === undefined) === (request.targetAmount === undefined)) {
      throw new ValidationError('Give exactly one of sourceAmount or targetAmount.', { fields: ['sourceAmount', 'targetAmount'] });
    }
    const mode = request.sourceAmount !== undefined ? QuoteAmountMode.SOURCE : QuoteAmountMode.TARGET;
    const misplaced = mode === QuoteAmountMode.SOURCE ? request.maximumSourceAmount : request.minimumTargetAmount;
    if (misplaced !== undefined) {
      throw new ValidationError('Bound a SOURCE-amount conversion with minimumTargetAmount, a TARGET-amount one with maximumSourceAmount.', {
        fields: ['minimumTargetAmount', 'maximumSourceAmount'],
      });
    }
    const boundText = mode === QuoteAmountMode.SOURCE ? request.minimumTargetAmount : request.maximumSourceAmount;
    return {
      mode,
      amountMinor: parseMinorString((request.sourceAmount ?? request.targetAmount) as string),
      bound: boundText === undefined ? undefined : parseMinorString(boundText),
    };
  }
}
