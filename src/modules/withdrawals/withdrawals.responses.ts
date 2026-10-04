import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { ApiAmount, ApiCurrency, ApiInstant, ApiMinorUnit, ApiUuid } from '../../openapi/properties';
import { BankDirectoryPage, DirectoryBank } from './bank-directory.service';
import { BeneficiaryAccepted, BeneficiaryPage, BeneficiaryView } from './beneficiary.service';
import { WithdrawalAccepted, WithdrawalView } from './withdrawal.service';

const BENEFICIARY_ID = '6a1f9c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const WITHDRAWAL_ID = '3f2c4c3e-8d2b-4a51-9b6f-0e1d2c3b4a59';

@ApiSchema({ name: 'WithdrawalBank' })
export class WithdrawalBankDocument implements DirectoryBank {
  @ApiProperty({ example: '058', description: 'Send this as `bankCode`.' })
  bankCode!: string;

  @ApiProperty({ example: 'Guaranty Trust Bank' })
  bankName!: string;

  @ApiCurrency()
  currency!: string;
}

@ApiSchema({ name: 'WithdrawalBankPage' })
export class WithdrawalBankPageDocument implements BankDirectoryPage {
  @ApiProperty({ type: [WithdrawalBankDocument] })
  items!: WithdrawalBankDocument[];

  @ApiProperty({ type: 'string', nullable: true, example: null, description: 'Bound to the directory snapshot it pages; a changed directory is `400 INVALID_CURSOR`.' })
  nextCursor!: string | null;

  @ApiInstant('When this directory was read from Paystack (a failed refresh keeps serving the previous complete one).')
  asOf!: string;
}

@ApiSchema({ name: 'WithdrawalBeneficiaryAccepted' })
export class BeneficiaryAcceptedDocument implements BeneficiaryAccepted {
  @ApiUuid('Poll `GET /wallet/withdrawal-beneficiaries/{beneficiaryId}` until READY (or FAILED). The same destination added again returns the same beneficiary.', BENEFICIARY_ID)
  beneficiaryId!: string;

  @ApiProperty({ enum: ['PENDING', 'READY', 'FAILED'], example: 'PENDING' })
  status!: 'PENDING' | 'READY' | 'FAILED';
}

@ApiSchema({ name: 'WithdrawalBeneficiary' })
export class BeneficiaryDocument implements BeneficiaryView {
  @ApiUuid('The beneficiary.', BENEFICIARY_ID)
  beneficiaryId!: string;

  @ApiProperty({ enum: ['PENDING', 'READY', 'FAILED'], example: 'READY', description: 'PENDING while Paystack resolves the account and the recipient is created; only READY can receive.' })
  status!: 'PENDING' | 'READY' | 'FAILED';

  @ApiProperty({ example: '058' })
  bankCode!: string;

  @ApiProperty({ type: 'string', nullable: true, example: 'Guaranty Trust Bank', description: 'As Paystack names it; null until READY.' })
  bankName!: string | null;

  @ApiCurrency()
  currency!: string;

  @ApiProperty({ example: '******6789', description: 'Only the last four digits are ever shown.' })
  accountNumberMasked!: string;

  @ApiProperty({ type: 'string', nullable: true, example: 'ADA LOVELACE', description: 'The name Paystack resolved for the account; null until resolved. Check it before withdrawing.' })
  accountName!: string | null;

  @ApiProperty({ type: 'string', nullable: true, example: null, description: 'Why it FAILED (e.g. `ACCOUNT_NOT_RESOLVED`).' })
  failureCode!: string | null;

  @ApiProperty({ example: false, description: 'An operator is looking at it; it stays PENDING meanwhile.' })
  reviewRequired!: boolean;

  @ApiInstant('When it was added.')
  createdAt!: string;
}

@ApiSchema({ name: 'WithdrawalBeneficiaryPage' })
export class BeneficiaryPageDocument implements BeneficiaryPage {
  @ApiProperty({ type: [BeneficiaryDocument] })
  items!: BeneficiaryDocument[];

  @ApiProperty({ type: 'string', nullable: true, example: null })
  nextCursor!: string | null;
}

@ApiSchema({ name: 'PaystackWithdrawalAccepted' })
export class WithdrawalAcceptedDocument implements WithdrawalAccepted {
  @ApiUuid('Poll `GET /wallet/withdraw/{withdrawalId}`. Your available balance already excludes the amount (it is held).', WITHDRAWAL_ID)
  withdrawalId!: string;

  @ApiProperty({ enum: ['PENDING'], example: 'PENDING' })
  status!: 'PENDING';

  @ApiAmount('As requested.', '300000')
  amount!: string;

  @ApiCurrency()
  currency!: string;

  @ApiAmount('What you pay for the withdrawal: always zero (Paystack\'s fee is ours).', '0')
  fee!: string;

  @ApiAmount('What leaves your wallet: the amount.', '300000')
  totalDebit!: string;

  @ApiProperty({ enum: ['paystack'], example: 'paystack' })
  provider!: 'paystack';

  @ApiProperty({ enum: [true], example: true, description: 'Paystack TEST mode: no real bank receives money; the stash is a simulated bank.' })
  simulated!: true;
}

class WithdrawalDestinationDocument {
  @ApiProperty({ example: '058' })
  bankCode!: string;

  @ApiProperty({ example: 'Guaranty Trust Bank' })
  bankName!: string;

  @ApiProperty({ example: '******6789' })
  accountNumberMasked!: string;

  @ApiProperty({ example: 'ADA LOVELACE' })
  accountName!: string;
}

@ApiSchema({ name: 'PaystackWithdrawal' })
export class WithdrawalDocument implements WithdrawalView {
  @ApiUuid('The withdrawal.', WITHDRAWAL_ID)
  withdrawalId!: string;

  @ApiProperty({
    enum: ['PENDING', 'COMPLETED', 'FAILED', 'REVERSED'],
    example: 'COMPLETED',
    description: 'COMPLETED only after Paystack\'s verify API confirms the exact transfer; FAILED released your hold; REVERSED returned the money.',
  })
  status!: 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERSED';

  @ApiAmount('The amount.', '300000')
  amount!: string;

  @ApiCurrency()
  currency!: string;

  @ApiMinorUnit()
  minorUnit!: number;

  @ApiAmount('Always zero.', '0')
  fee!: string;

  @ApiAmount('What leaves your wallet.', '300000')
  totalDebit!: string;

  @ApiProperty({ enum: ['paystack'], example: 'paystack' })
  provider!: 'paystack';

  @ApiProperty({ enum: [true], example: true })
  simulated!: true;

  @ApiProperty({ type: WithdrawalDestinationDocument, description: 'The destination frozen when you asked (later changes to the beneficiary never apply).' })
  destination!: WithdrawalDestinationDocument;

  @ApiProperty({ example: `withdrawal:${WITHDRAWAL_ID}`, description: 'The reference in `GET /transactions` (stable from the start).' })
  transactionReference!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, example: null, description: 'The stash receipt confirming the money arrived; null until COMPLETED.' })
  stashReceiptId!: string | null;

  @ApiProperty({ type: 'string', nullable: true, example: null, description: 'Why it FAILED (e.g. `TRANSFER_FAILED`, `USER_SUSPENDED`).' })
  failureCode!: string | null;

  @ApiProperty({ example: false, description: 'An operator is looking at it; your money stays held meanwhile.' })
  reviewRequired!: boolean;

  @ApiInstant('When you asked.')
  createdAt!: string;

  @ApiInstant('When it COMPLETED or FAILED; null while PENDING.', null, { nullable: true })
  completedAt!: string | null;
}
