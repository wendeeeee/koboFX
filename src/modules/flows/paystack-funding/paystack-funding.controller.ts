import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiAcceptedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Idempotent } from '../../../common/decorators';
import { ErrorCode } from '../../../common/errors';
import { AuthenticatedUser } from '../../../common/guards/authenticated-request';
import { ApiErrors } from '../../../openapi/api-errors.decorator';
import { PaystackFundingAcceptedDocument } from '../../wallets/wallet.responses';
import { PaystackFundWalletDto } from './dto/paystack-fund-wallet.dto';
import { PaystackFundingAccepted, PaystackFundingService } from './paystack-funding.service';


@ApiTags('wallet')
@Controller('wallet')
export class PaystackFundingController {
  constructor(private readonly funding: PaystackFundingService) {}

  @Post('fund/paystack')
  @HttpCode(HttpStatus.ACCEPTED)
  @Idempotent({ flowIdField: 'fundingId' })
  @ApiOperation({
    summary: 'Fund the wallet through Paystack',
    description:
      'Starts a Paystack funding and answers `202 PENDING` at once: the API never calls Paystack — the worker ' +
      'initializes the checkout after this commits. Poll `GET /wallet/fund/{fundingId}` until `checkout.authorizationUrl` ' +
      'appears and send the customer there. The balance is credited only when Paystack\'s verify API confirms the payment ' +
      'with the same amount and currency; the browser\'s return to your callback page proves nothing.',
  })
  @ApiAcceptedResponse({ type: PaystackFundingAcceptedDocument })
  @ApiErrors(ErrorCode.INVALID_AMOUNT, ErrorCode.UNSUPPORTED_CURRENCY, ErrorCode.AMOUNT_TOO_SMALL, ErrorCode.AMOUNT_TOO_LARGE)
  fund(@CurrentUser() user: AuthenticatedUser, @Body() body: PaystackFundWalletDto): Promise<PaystackFundingAccepted> {
    return this.funding.start(user.id, body);
  }
}
