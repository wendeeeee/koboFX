import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Idempotent } from '../../common/decorators';
import { ErrorCode } from '../../common/errors';
import { ApiErrors } from '../../openapi/api-errors.decorator';
import { AuthenticatedUser } from '../../common/guards/authenticated-request';
import { FundWalletDto } from '../flows/funding/dto/fund-wallet.dto';
import { FundingAccepted, FundingService, FundingView } from '../flows/funding/funding.service';
import { WalletBalance, WalletBalancesService } from './wallet-balances.service';
import { FundingAcceptedDocument, FundingDocument, WalletDocument } from './wallet.responses';

/**
 * The wallet (design §12). Every query is scoped by the authenticated caller's id in its
 * WHERE clause; ids from the path only ever narrow within the caller's own data.
 */
@ApiTags('wallet')
@Controller('wallet')
export class WalletController {
  constructor(
    private readonly balances: WalletBalancesService,
    private readonly funding: FundingService,
  ) {}

  /** Total, reserved and available per currency, as strings of minor units. */
  @Get()
  @ApiOperation({ summary: 'My balances', description: 'Total, reserved and available per currency, as strings of minor units (design §12).' })
  @ApiOkResponse({ type: WalletDocument })
  async wallet(@CurrentUser() user: AuthenticatedUser): Promise<{ balances: WalletBalance[] }> {
    return { balances: await this.balances.balancesOf(user.id) };
  }

  /** Starts a funding flow; `202 PENDING`. The PSP is called by the worker, after this commits. */
  @Post('fund')
  @HttpCode(HttpStatus.ACCEPTED)
  @Idempotent({ flowIdField: 'fundingId' })
  @ApiOperation({
    summary: 'Fund the wallet by card',
    description:
      'Starts a funding flow and answers `202 PENDING` at once: the API never calls the PSP — the worker does, after ' +
      'this commits. Poll `GET /wallet/fund/{fundingId}` (or history). The balance is credited only once the PSP confirms the capture.',
  })
  @ApiAcceptedResponse({ type: FundingAcceptedDocument })
  @ApiErrors(ErrorCode.INVALID_AMOUNT, ErrorCode.UNSUPPORTED_CURRENCY, ErrorCode.AMOUNT_TOO_SMALL, ErrorCode.AMOUNT_TOO_LARGE)
  fund(@CurrentUser() user: AuthenticatedUser, @Body() body: FundWalletDto): Promise<FundingAccepted> {
    return this.funding.start(user.id, body);
  }

  @Get('fund/:fundingId')
  @ApiOperation({ summary: 'A funding\'s status', description: 'Scoped to the caller: another user\'s funding is the same 404 as an unknown one.' })
  @ApiParam({ name: 'fundingId', format: 'uuid', description: 'A version-4 UUID (from `POST /wallet/fund`).' })
  @ApiOkResponse({ type: FundingDocument })
  @ApiErrors(ErrorCode.FUNDING_NOT_FOUND)
  findFunding(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fundingId', new ParseUUIDPipe({ version: '4' })) fundingId: string,
  ): Promise<FundingView> {
    return this.funding.find(user.id, fundingId);
  }
}
