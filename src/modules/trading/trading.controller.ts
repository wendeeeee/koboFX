import { Body, Controller, Headers, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Idempotent } from '../../common/decorators';
import { ErrorCode } from '../../common/errors';
import { ApiErrors } from '../../openapi/api-errors.decorator';
import { AuthenticatedUser } from '../../common/guards/authenticated-request';
import { ServedSnapshot } from '../fx/fx-rate.service';
import { PreparedRateSnapshot, RateSnapshotGuard } from '../fx/rate-snapshot.guard';
import { ConversionView } from './conversion.view';
import { ConvertService } from './convert.service';
import { ConvertDto } from './dto/convert.dto';
import { TradeDto } from './dto/trade.dto';
import { TradeService } from './trade.service';
import { ConversionDocument } from './trading.responses';


const POSTING_ERRORS = [
  ErrorCode.ACCOUNT_SUSPENDED,
  ErrorCode.EMAIL_NOT_VERIFIED,
  ErrorCode.INSUFFICIENT_FUNDS,
  ErrorCode.FUNDS_RESERVED,
  ErrorCode.AMOUNT_TOO_LARGE,
  ErrorCode.DAILY_LIMIT_EXCEEDED,
  ErrorCode.LEDGER_UNBALANCED,
  ErrorCode.INVALID_POSTING,
  ErrorCode.ACCOUNT_CURRENCY_MISMATCH,
  ErrorCode.INVALID_RESERVATION,
] as const;


@ApiTags('trading')
@Controller('wallet')
export class TradingController {
  constructor(
    private readonly convertService: ConvertService,
    private readonly tradeService: TradeService,
  ) {}


  @Post('convert')
  @UseGuards(RateSnapshotGuard)
  @Idempotent({ transactionIdField: 'transactionId' })
  @ApiOperation({
    summary: 'Convert at the market rate',
    description:
      'Priced at execution from the current executable rate and posted in the same request (design §7.7). Give ' +
      'exactly one of `sourceAmount` / `targetAmount`; optional price protection: `minimumTargetAmount` (with ' +
      '`sourceAmount`) or `maximumSourceAmount` (with `targetAmount`) — `maxSlippageBps` is refused. Insufficient ' +
      'funds: `INSUFFICIENT_FUNDS` (top up) vs `FUNDS_RESERVED` (wait for your pending operation). The stored ' +
      '`201` replays byte for byte, even after the rate moves.',
  })
  @ApiBody({
    type: ConvertDto,
    examples: {
      sellNairaProtected: {
        summary: 'SOURCE mode: sell ₦1,530,000.00, refuse below $980.00',
        value: { from: 'NGN', to: 'USD', sourceAmount: '153000000', minimumTargetAmount: '98000' },
      },
      buyDollarsProtected: {
        summary: 'TARGET mode: buy $50.00, refuse above ₦78,000.00',
        value: { from: 'NGN', to: 'USD', targetAmount: '5000', maximumSourceAmount: '7800000' },
      },
    },
  })
  @ApiCreatedResponse({ type: ConversionDocument })
  @ApiErrors(
    ErrorCode.INVALID_AMOUNT,
    ErrorCode.UNSUPPORTED_CURRENCY,
    ErrorCode.SAME_CURRENCY,
    ErrorCode.UNSUPPORTED_CURRENCY_PAIR,
    ErrorCode.PRICE_LIMIT_EXCEEDED,
    ErrorCode.AMOUNT_TOO_SMALL,
    ErrorCode.FX_RATE_STALE,
    ErrorCode.FX_RATE_UNAVAILABLE,
    ...POSTING_ERRORS,
  )
  convert(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ConvertDto,
    @PreparedRateSnapshot() prepared: ServedSnapshot | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<ConversionView> {
    return this.convertService.convert(user.id, body, prepared, idempotencyKey);
  }

  @Post('trade')
  @Idempotent({ transactionIdField: 'transactionId' })
  @ApiOperation({
    summary: 'Execute a quote',
    description:
      'Posts the quote\'s locked amounts verbatim; no current rate is needed. The quote is consumed only if the trade ' +
      'posts: a refused trade leaves it OPEN (retry with a NEW key while it lasts).',
  })
  @ApiCreatedResponse({ type: ConversionDocument })
  @ApiErrors(ErrorCode.QUOTE_NOT_FOUND, ErrorCode.QUOTE_EXPIRED, ErrorCode.QUOTE_ALREADY_USED, ...POSTING_ERRORS)
  trade(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: TradeDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<ConversionView> {
    return this.tradeService.trade(user.id, body, idempotencyKey);
  }
}
