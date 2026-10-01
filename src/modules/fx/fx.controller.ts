import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AllowUnverified, CurrentUser, Idempotent } from '../../common/decorators';
import { ErrorCode } from '../../common/errors';
import { ApiErrors } from '../../openapi/api-errors.decorator';
import { AuthenticatedUser } from '../../common/guards/authenticated-request';
import { CurrencyPairRepository } from './currency-pair.repository';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { FxRateService, ServedSnapshot } from './fx-rate.service';
import { QuoteDocument, RatesDocument } from './fx.responses';
import { RatesView, ratesView } from './fx-rates.view';
import { QuoteService, QuoteView } from './quote.service';
import { PreparedRateSnapshot, RateSnapshotGuard } from './rate-snapshot.guard';

/**
 * FX (design §12). `GET /fx/rates` needs a session but not a verified one (§12: "✔");
 * quotes need a verified user (the global guard chain). Serving either costs no provider
 * call: rates come from the cache or the database snapshot.
 */
@ApiTags('fx')
@Controller('fx')
export class FxController {
  constructor(
    private readonly rates: FxRateService,
    private readonly pairs: CurrencyPairRepository,
    private readonly quotes: QuoteService,
  ) {}

  @Get('rates')
  @AllowUnverified()
  @ApiOperation({
    summary: 'Current rates',
    description:
      'Every active directional pair with its reference mid and client rate (display strings), from the cache or the ' +
      'stored snapshot — never a provider call per request. `stale: true` means display only: quotes and conversions ' +
      'are refused until a fresh rate arrives. A stale rate may be displayed; it may never be executed against.',
  })
  @ApiOkResponse({ type: RatesDocument })
  @ApiErrors(ErrorCode.FX_RATE_UNAVAILABLE)
  async currentRates(): Promise<RatesView> {
    const served = await this.rates.displayable();
    return ratesView(served, await this.pairs.active());
  }

  /** 30s, single-use, directional; behind the idempotency barrier. The rate is prepared before it. */
  @Post('quotes')
  @UseGuards(RateSnapshotGuard)
  @Idempotent()
  @ApiOperation({
    summary: 'Get a quote',
    description:
      'A 30-second, single-use, directional price that locks both amounts (design §7.7). Give exactly one of ' +
      '`sourceAmount` (how much `from` to sell) or `targetAmount` (how much `to` to receive). No balance check and no ' +
      'hold: execute it with `POST /wallet/trade`. Needs an executable rate (`503 FX_RATE_STALE` otherwise, transient).',
  })
  @ApiBody({
    type: CreateQuoteDto,
    examples: {
      sellNaira: { summary: 'SOURCE mode: sell ₦1,530,000.00 for USD', value: { from: 'NGN', to: 'USD', sourceAmount: '153000000' } },
      buyDollars: { summary: 'TARGET mode: buy $50.00 with NGN', value: { from: 'NGN', to: 'USD', targetAmount: '5000' } },
    },
  })
  @ApiCreatedResponse({ type: QuoteDocument })
  @ApiErrors(
    ErrorCode.INVALID_AMOUNT,
    ErrorCode.UNSUPPORTED_CURRENCY,
    ErrorCode.SAME_CURRENCY,
    ErrorCode.UNSUPPORTED_CURRENCY_PAIR,
    ErrorCode.AMOUNT_TOO_SMALL,
    ErrorCode.FX_RATE_STALE,
    ErrorCode.FX_RATE_UNAVAILABLE,
  )
  createQuote(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateQuoteDto,
    @PreparedRateSnapshot() prepared: ServedSnapshot | undefined,
  ): Promise<QuoteView> {
    return this.quotes.create(user.id, body, prepared);
  }

  @Get('quotes/:quoteId')
  @ApiOperation({ summary: 'A quote', description: 'Your own quotes only: another user\'s is the same 404 as an unknown one.' })
  @ApiParam({ name: 'quoteId', format: 'uuid', description: 'A version-4 UUID.' })
  @ApiOkResponse({ type: QuoteDocument })
  @ApiErrors(ErrorCode.QUOTE_NOT_FOUND)
  findQuote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('quoteId', new ParseUUIDPipe({ version: '4' })) quoteId: string,
  ): Promise<QuoteView> {
    return this.quotes.find(user.id, quoteId);
  }
}
