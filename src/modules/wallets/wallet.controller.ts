import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser, Idempotent } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/guards/authenticated-request';
import { FundWalletDto } from '../flows/funding/dto/fund-wallet.dto';
import { FundingAccepted, FundingService, FundingView } from '../flows/funding/funding.service';
import { WalletBalance, WalletBalancesService } from './wallet-balances.service';

/**
 * The wallet (design §12). Every query is scoped by the authenticated caller's id in its
 * WHERE clause; ids from the path only ever narrow within the caller's own data.
 */
@Controller('wallet')
export class WalletController {
  constructor(
    private readonly balances: WalletBalancesService,
    private readonly funding: FundingService,
  ) {}

  /** Total, reserved and available per currency, as strings of minor units. */
  @Get()
  async wallet(@CurrentUser() user: AuthenticatedUser): Promise<{ balances: WalletBalance[] }> {
    return { balances: await this.balances.balancesOf(user.id) };
  }

  /** Starts a funding flow; `202 PENDING`. The PSP is called by the worker, after this commits. */
  @Post('fund')
  @HttpCode(HttpStatus.ACCEPTED)
  @Idempotent({ flowIdField: 'fundingId' })
  fund(@CurrentUser() user: AuthenticatedUser, @Body() body: FundWalletDto): Promise<FundingAccepted> {
    return this.funding.start(user.id, body);
  }

  @Get('fund/:fundingId')
  findFunding(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fundingId', new ParseUUIDPipe({ version: '4' })) fundingId: string,
  ): Promise<FundingView> {
    return this.funding.find(user.id, fundingId);
  }
}
