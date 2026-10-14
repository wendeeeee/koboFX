import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { TransactionPinResetCodeRequested, TransactionPinStatus } from './transaction-pin.service';

@ApiSchema({ name: 'TransactionPinStatus' })
export class TransactionPinStatusDocument implements TransactionPinStatus {
  @ApiProperty({ example: true, description: 'You have a transaction PIN (required to withdraw and to convert).' })
  set!: boolean;

  @ApiProperty({ example: false, description: 'Locked after too many wrong PINs: reset it with your password and an emailed code.' })
  locked!: boolean;
}

@ApiSchema({ name: 'TransactionPinResetCodeRequested' })
export class TransactionPinResetCodeRequestedDocument implements TransactionPinResetCodeRequested {
  @ApiProperty({ enum: ['REQUESTED'], example: 'REQUESTED', description: 'The code is generated and emailed by the worker, within seconds.' })
  status!: 'REQUESTED';

  @ApiProperty({ enum: ['EMAIL'], example: 'EMAIL' })
  channel!: 'EMAIL';

  @ApiProperty({ type: 'integer', example: 600, description: 'How long the code stays valid once sent.' })
  expiresInSeconds!: number;
}
