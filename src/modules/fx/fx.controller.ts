import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AllowUnverified, CurrentUser, Idempotent } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/guards/authenticated-request';
import { CurrencyPairRepository } from './currency-pair.repository';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { FxRateService, ServedSnapshot } from './fx-rate.service';
import { RatesView, ratesView } from './fx-rates.view';
import { QuoteService, QuoteView } from './quote.service';
import { PreparedRateSnapshot, RateSnapshotGuard } from './rate-snapshot.guard';

/**
 * FX (design §12). `GET /fx/rates` needs a session but not a verified one (§12: "✔");
 * quotes need a verified user (the global guard chain). Serving either costs no provider
 * call: rates come from the cache or the database snapshot.
 */
@Controller('fx')
export class FxController {
  constructor(
    private readonly rates: FxRateService,
    private readonly pairs: CurrencyPairRepository,
    private readonly quotes: QuoteService,
  ) {}

  @Get('rates')
  @AllowUnverified()
  async currentRates(): Promise<RatesView> {
    const served = await this.rates.displayable();
    return ratesView(served, await this.pairs.active());
  }

  /** 30s, single-use, directional; behind the idempotency barrier. The rate is prepared before it. */
  @Post('quotes')
  @UseGuards(RateSnapshotGuard)
  @Idempotent()
  createQuote(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateQuoteDto,
    @PreparedRateSnapshot() prepared: ServedSnapshot | undefined,
  ): Promise<QuoteView> {
    return this.quotes.create(user.id, body, prepared);
  }

  @Get('quotes/:quoteId')
  findQuote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('quoteId', new ParseUUIDPipe({ version: '4' })) quoteId: string,
  ): Promise<QuoteView> {
    return this.quotes.find(user.id, quoteId);
  }
}
