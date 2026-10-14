import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { TRANSACTION_PIN_PATTERN } from '../transaction-pin';

/** The `transactionPin` every withdrawal and conversion carries: the user's 6-digit PIN, the final confirmation. */
export const TransactionPinField = () =>
  applyDecorators(
    ApiProperty({
      type: 'string',
      pattern: '^\\d{6}$',
      example: '402815',
      description: 'Your 6-digit transaction PIN, the final confirmation. Wrong: `400 TRANSACTION_PIN_INVALID` (5 in a row lock it).',
    }),
    IsString(),
    Matches(TRANSACTION_PIN_PATTERN, { message: 'transactionPin must be your 6-digit transaction PIN' }),
  );
