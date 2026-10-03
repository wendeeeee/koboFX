import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { ApiAmount, ApiCurrency, ApiInstant, ApiMinorUnit, ApiUuid } from '../../openapi/properties';
import type { FundingAccepted, FundingCheckoutView, FundingView } from '../flows/funding/funding.service';
import type { PaystackFundingAccepted } from '../flows/paystack-funding/paystack-funding.service';
import type { WalletBalance } from './wallet-balances.service';

@ApiSchema({ name: 'WalletBalance' })
export class WalletBalanceDocument implements WalletBalance {
  @ApiCurrency()
  currency!: string;

  @ApiMinorUnit()
  minorUnit!: number;

  @ApiAmount('The ledger balance. May be negative (an overdraft, e.g. after a chargeback).', '250000')
  total!: string;

  @ApiAmount('Held by operations in flight.', '0')
  reserved!: string;

  @ApiAmount('`total − reserved`: what can be spent now.', '250000')
  available!: string;
}

@ApiSchema({ name: 'Wallet' })
export class WalletDocument {
  @ApiProperty({ type: [WalletBalanceDocument], description: 'One entry per currency the user holds an account in, by currency code.' })
  balances!: WalletBalanceDocument[];
}

const FUNDING_ID = '3c9a1f2e-7b4d-4e6a-9f80-1a2b3c4d5e6f';

@ApiSchema({ name: 'FundingAccepted' })
export class FundingAcceptedDocument implements FundingAccepted {
  @ApiUuid('Poll `GET /wallet/fund/{fundingId}`; history lists it as `funding:{fundingId}`.', FUNDING_ID)
  fundingId!: string;

  @ApiProperty({ enum: ['PENDING'], example: 'PENDING' })
  status!: 'PENDING';

  @ApiAmount('As requested.', '150000')
  amount!: string;

  @ApiCurrency()
  currency!: string;
}

@ApiSchema({ name: 'PaystackFundingAccepted' })
export class PaystackFundingAcceptedDocument implements PaystackFundingAccepted {
  @ApiUuid('Poll `GET /wallet/fund/{fundingId}` until `checkout.authorizationUrl` appears (normally within a second or two), then send the customer there.', FUNDING_ID)
  fundingId!: string;

  @ApiProperty({ enum: ['PENDING'], example: 'PENDING' })
  status!: 'PENDING';

  @ApiAmount('As requested.', '150000')
  amount!: string;

  @ApiCurrency()
  currency!: string;

  @ApiProperty({ enum: ['paystack'], example: 'paystack' })
  provider!: 'paystack';
}

@ApiSchema({ name: 'FundingCheckout' })
export class FundingCheckoutDocument implements FundingCheckoutView {
  @ApiProperty({
    type: 'string',
    format: 'uri',
    example: 'https://checkout.paystack.com/0peioxfhpn',
    description: 'Paystack\'s hosted checkout for this funding. Redirect the customer here; the return to your callback page carries no authority — poll this route.',
  })
  authorizationUrl!: string;

  @ApiInstant('The end of OUR checkout window: after it, an unpaid funding FAILS (a later payment is caught by reconciliation, never lost).')
  expiresAt!: string;
}

@ApiSchema({ name: 'Funding' })
export class FundingDocument implements FundingView {
  @ApiUuid('The funding id.', FUNDING_ID)
  fundingId!: string;

  @ApiProperty({
    enum: ['PENDING', 'COMPLETED', 'FAILED', 'REVERSED'],
    example: 'COMPLETED',
    description: 'The one wire status (also history\'s). COMPLETED = credited; REVERSED = a chargeback took it back.',
  })
  status!: 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERSED';

  @ApiAmount('As requested.', '150000')
  amount!: string;

  @ApiCurrency()
  currency!: string;

  @ApiProperty({ enum: ['simulated', 'paystack'], example: 'simulated', description: 'Which provider takes the payment (`POST /wallet/fund` = simulated, `POST /wallet/fund/paystack` = paystack).' })
  provider!: 'simulated' | 'paystack';

  @ApiProperty({
    type: FundingCheckoutDocument,
    nullable: true,
    example: null,
    description: 'Paystack only, and only while the customer can still pay: ready and inside the checkout window. Otherwise null.',
  })
  checkout!: FundingCheckoutDocument | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    example: null,
    description: 'Why it FAILED: the PSP\'s status, with its decline code when given (e.g. `DECLINED:insufficient_funds`), or `USER_SUSPENDED`; Paystack: `CHECKOUT_EXPIRED:{status}`, `CHECKOUT_UNRECOVERABLE`, `PAYSTACK_REVERSED`. Never card data.',
  })
  failureCode!: string | null;

  @ApiProperty({ type: 'string', nullable: true, example: `funding:${FUNDING_ID}`, description: 'The ledger reference once credited (`GET /transactions/{reference}`).' })
  transactionReference!: string | null;

  @ApiInstant('When the funding was requested.')
  createdAt!: string;

  @ApiInstant('Last change.')
  updatedAt!: string;
}
