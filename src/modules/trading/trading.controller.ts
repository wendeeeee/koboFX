import { Body, Controller, Headers, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, Idempotent } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/guards/authenticated-request';
import { ServedSnapshot } from '../fx/fx-rate.service';
import { PreparedRateSnapshot, RateSnapshotGuard } from '../fx/rate-snapshot.guard';
import { ConversionView } from './conversion.view';
import { ConvertService } from './convert.service';
import { ConvertDto } from './dto/convert.dto';
import { TradeDto } from './dto/trade.dto';
import { TradeService } from './trade.service';

/**
 * Conversion and trading (design §7.7, §12), under `wallet/` but in their own controller so
 * `wallets/` stays balances and funding. Both are behind the idempotency barrier and are
 * database-only inside it; both answer `201` with the same body shape, stored and replayed
 * byte for byte, and link the posted transaction on the key row.
 */
@Controller('wallet')
export class TradingController {
  constructor(
    private readonly convertService: ConvertService,
    private readonly tradeService: TradeService,
  ) {}

  /** A market conversion. The executable rate is prepared BEFORE the barrier opens its transaction. */
  @Post('convert')
  @UseGuards(RateSnapshotGuard)
  @Idempotent({ transactionIdField: 'transactionId' })
  convert(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ConvertDto,
    @PreparedRateSnapshot() prepared: ServedSnapshot | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<ConversionView> {
    return this.convertService.convert(user.id, body, prepared, idempotencyKey);
  }

  /** Execute a quote: its locked amounts, verbatim. Needs no current rate, so no guard. */
  @Post('trade')
  @Idempotent({ transactionIdField: 'transactionId' })
  trade(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: TradeDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<ConversionView> {
    return this.tradeService.trade(user.id, body, idempotencyKey);
  }
}
